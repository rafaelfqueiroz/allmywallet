import { z } from 'zod';
import { Money } from '@/core/shared/money';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import { QuoteProviderErrorCode, type QuoteProvider, type QuoteProviderResult } from '@/core/quotes/ports';
import { extractJsonDecimalField } from './decimal-json';

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
  /**
   * #151 — sent as `Authorization: Bearer`, brapi's documented scheme, never
   * as a `?token=` query parameter: a URL is what ends up in fetch
   * breadcrumbs, traces and proxy logs, and a header is not.
   */
  readonly apiToken?: string;
  /** Persisted alongside every quote so BR-008-04 can name the source (`quotes.provider`'s resolved value). */
  readonly source: string;
}

const DEFAULT_BASE_URL = 'https://brapi.dev/api';
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

export class BrapiQuoteProvider implements QuoteProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: BrapiConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private headers(): Record<string, string> {
    return this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {};
  }

  async fetchQuote(ticker: string): Promise<Result<QuoteProviderResult, DomainError>> {
    const url = new URL(`${this.baseUrl}/quote/${encodeURIComponent(ticker)}`);

    let rawBody: string;
    let status: number;
    try {
      const response = await fetch(url, { method: 'GET', headers: this.headers() });
      status = response.status;
      rawBody = await response.text();
    } catch {
      // Network failure — a genuine transient fault (BR-008-27), not "ticker unknown".
      return err(domainError(QuoteProviderErrorCode.UNAVAILABLE, { ticker }));
    }

    // #151: a missing or invalid token (401) and a plan that does not cover
    // the ticker (403) are refusals of *us*, not evidence the ticker does not
    // exist — reporting them as NOT_FOUND would call every held asset unknown.
    if (status >= 500 || status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
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
}
