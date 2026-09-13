import { z } from 'zod';
import { Money } from '@/core/shared/money';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import { BusinessDate, businessDateInSaoPaulo } from '@/core/shared/clock';
import {
  QuoteProviderErrorCode,
  type HistoricalClose,
  type HistoricalClosesResult,
  type QuoteProvider,
  type QuoteProviderResult,
} from '@/core/quotes/ports';
import { extractJsonDecimalField } from './decimal-json';

/**
 * SPEC-021 BR-021-29 — brapi's `range` values, smallest first, with the
 * calendar-day span each is safe to cover. brapi counts a range back from
 * *its* now, not from the requested `to`, so the span chosen is `to − from`
 * plus `RANGE_MARGIN_DAYS`: catch-up's `to` is at most a day or two behind
 * today, and the margin absorbs that. A day the chosen range still does not
 * reach is simply absent from the response and becomes a recorded gap —
 * visible, never guessed.
 */
const HISTORY_RANGES: readonly { readonly range: string; readonly maxCalendarDays: number }[] = [
  { range: '1mo', maxCalendarDays: 28 },
  { range: '3mo', maxCalendarDays: 89 },
  { range: '6mo', maxCalendarDays: 180 },
  { range: '1y', maxCalendarDays: 364 },
  { range: '2y', maxCalendarDays: 729 },
  { range: '5y', maxCalendarDays: 1826 },
];
const RANGE_MARGIN_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;

function calendarDaysBetween(from: BusinessDate, to: BusinessDate): number {
  const millis = (date: BusinessDate): number => {
    const [year, month, day] = date.split('-').map((part) => Number(part));
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  };
  // Both ends are UTC midnights, so the difference is an exact multiple of a
  // day — no rounding decision exists here to make.
  return (millis(to) - millis(from)) / MILLISECONDS_PER_DAY;
}

export function historyRangeFor(from: BusinessDate, to: BusinessDate): string {
  const span = calendarDaysBetween(from, to) + RANGE_MARGIN_DAYS;
  return HISTORY_RANGES.find((candidate) => span <= candidate.maxCalendarDays)?.range ?? 'max';
}

/**
 * AR-06 — every `close` in `historicalDataPrice` is read from the raw body
 * text, never from `JSON.parse`'s numbers. The array's entries are flat
 * objects, so each `{…}` slice is scanned on its own: `extractJsonDecimalField`
 * returns the first match only, and applied to the whole body it would return
 * the first day's close for every day.
 *
 * `"close"` is matched with its opening quote, so `"adjustedClose"` is never
 * read in its place — the official close is what `quotes.close-capture`
 * writes (BR-008-09), and a dividend-adjusted series would disagree with it.
 */
export function extractHistoricalCloses(
  rawBody: string,
  from: BusinessDate,
  to: BusinessDate,
): readonly HistoricalClose[] {
  const start = /"historicalDataPrice"\s*:\s*\[/.exec(rawBody);
  if (start === null) return [];
  const afterStart = rawBody.slice(start.index + start[0].length);
  const end = afterStart.indexOf(']');
  const arrayText = end === -1 ? afterStart : afterStart.slice(0, end);

  const byDate = new Map<BusinessDate, HistoricalClose>();
  for (const entry of arrayText.match(/\{[^{}]*\}/g) ?? []) {
    const epochSeconds = /"date"\s*:\s*(\d+)/.exec(entry)?.[1];
    const closeText = extractJsonDecimalField(entry, 'close');
    // A candle with a null close (a halted day) is not a close at all.
    if (epochSeconds === undefined || closeText === null) continue;
    // brapi stamps each daily candle with a Unix time inside that São Paulo
    // trading day; AR-29 reads the business date in São Paulo, never UTC.
    const date = businessDateInSaoPaulo(new Date(Number(epochSeconds) * 1000));
    if (BusinessDate.isBefore(date, from) || BusinessDate.isAfter(date, to)) continue;
    if (!byDate.has(date)) byDate.set(date, { date, close: Money.fromString(closeText) });
  }
  return [...byDate.values()].sort((a, b) => BusinessDate.compare(a.date, b.date));
}

/**
 * SPEC-008 BR-008-01/26/DL-008-01 — the free-tier brapi.dev client, selected
 * when `quotes.provider` resolves to the registry's brapi option
 * (`src/config/registry.ts`). One ticker per call (BR-008-19), ~30 min delay
 * (BR-008-01). AR-02/AR-03: `QuoteProvider` is the port; this is the
 * one implementation v1 ships, swappable by config without touching
 * valuation logic (BR-008-26).
 *
 * DV-11: named for the role in `core/quotes/ports.ts` (`QuoteProvider`), not
 * this class — callers depend on the interface, never on `BrapiQuoteProvider`
 * directly.
 */
const brapiResponseSchema = z.object({
  results: z
    .array(
      z.object({
        symbol: z.string(),
        // regularMarketPrice is read separately from the raw body text via
        // extractJsonDecimalField — never through this parsed number field,
        // which is only used for shape validation ("is a number present").
        regularMarketPrice: z.number().nullable().optional(),
        regularMarketTime: z.string().optional(),
      }),
    )
    .default([]),
});

export interface BrapiConfig {
  readonly baseUrl?: string;
  readonly apiToken?: string;
  /** Persisted alongside every quote so BR-008-04 can name the source (`quotes.provider`'s resolved value). */
  readonly source: string;
}

const DEFAULT_BASE_URL = 'https://brapi.dev/api';

export class BrapiQuoteProvider implements QuoteProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: BrapiConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async fetchQuote(ticker: string): Promise<Result<QuoteProviderResult, DomainError>> {
    const url = new URL(`${this.baseUrl}/quote/${encodeURIComponent(ticker)}`);
    if (this.config.apiToken) url.searchParams.set('token', this.config.apiToken);

    let rawBody: string;
    let status: number;
    try {
      const response = await fetch(url, { method: 'GET' });
      status = response.status;
      rawBody = await response.text();
    } catch {
      // Network failure — a genuine transient fault (BR-008-27), not "ticker unknown".
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker }));
    }

    if (status >= 500) {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker, status }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker, status }));
    }

    const shape = brapiResponseSchema.safeParse(parsed);
    if (!shape.success || shape.data.results.length === 0) {
      // BR-008-18: the provider does not have this ticker — a domain outcome, not a fault.
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }

    const result = shape.data.results[0];
    if (!result || result.regularMarketPrice === null || result.regularMarketPrice === undefined) {
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }

    // AR-06: the money field is read from the raw response text, never from
    // `result.regularMarketPrice` (already a JS `number` by the time Zod saw
    // it) — see decimal-json.ts.
    const priceText = extractJsonDecimalField(rawBody, 'regularMarketPrice');
    if (priceText === null) {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker, status }));
    }

    const quotedAt = result.regularMarketTime ? new Date(result.regularMarketTime) : new Date();

    return ok({
      ticker: result.symbol,
      price: Money.fromString(priceText),
      quotedAt,
      source: this.config.source,
    });
  }

  /**
   * SPEC-021 BR-021-29 — `GET /quote/{ticker}?range=…&interval=1d`, one
   * request for the whole window (BR-021-32 charges per request).
   *
   * Error mapping differs from `fetchQuote` on purpose: any 4xx here is
   * UNAVAILABLE, not NOT_FOUND. The ticker is already known to be real — it is
   * held, and was polled — so a refusal is far more likely the plan rejecting
   * the range than a missing instrument, and the day must be recorded as a
   * provider failure rather than as "the provider has no such close".
   */
  async fetchHistoricalCloses(
    ticker: string,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<Result<HistoricalClosesResult, DomainError>> {
    const url = new URL(`${this.baseUrl}/quote/${encodeURIComponent(ticker)}`);
    url.searchParams.set('range', historyRangeFor(from, to));
    url.searchParams.set('interval', '1d');
    if (this.config.apiToken) url.searchParams.set('token', this.config.apiToken);

    let rawBody: string;
    let status: number;
    try {
      const response = await fetch(url, { method: 'GET' });
      status = response.status;
      rawBody = await response.text();
    } catch {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker }));
    }

    if (status >= 400) {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker, status }));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker, status }));
    }

    const shape = brapiResponseSchema.safeParse(parsed);
    const result = shape.success ? shape.data.results[0] : undefined;
    if (result === undefined) {
      return err(domainError(QuoteProviderErrorCode.NOT_FOUND, { ticker }));
    }

    return ok({
      ticker: result.symbol,
      closes: extractHistoricalCloses(rawBody, from, to),
      source: this.config.source,
    });
  }
}
