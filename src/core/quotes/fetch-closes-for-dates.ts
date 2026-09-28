import type { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { fetchOfficialCloses, type WantedClose } from '@/core/quotes/fetch-official-closes';
import type { Clock, OfficialCloseSource, PriceQuote, TradingCalendar } from '@/core/quotes/ports';

/**
 * SPEC-005 BR-005-20d (#144) / DL-005-22, rewritten onto `fetchOfficialCloses`
 * for #171 — fetch and store the closes a subscription resolution needs,
 * ahead of the commit that reads them (`ClosePriceReader.closeOnOrBefore`).
 * Every close this writes is B3's own COTAHIST close (BR-008-09) — never an
 * intraday-provider quote — the same source `quotes.close-capture` and
 * catch-up write.
 *
 * A request is **covered** when a close from `source.source` already exists
 * on, or within `lookbackDays` before, `upTo`; otherwise every trading day in
 * `[upTo − lookbackDays, upTo]` for that asset is wanted. #144 review F2 still
 * holds here: two dates on the same asset are genuinely different questions,
 * so each is tracked and covered on its own — an old, out-of-window close on
 * the same asset never suppresses a fetch for a later date it does not price.
 *
 * Never fatal to the caller: a day COTAHIST does not supply (or has not yet
 * published) simply is not upserted — the commit that follows finds no
 * stored close and leaves the pair `unclassified` for a later import
 * (BR-005-20d). No gap is recorded on this path (`price_quote_gaps` is
 * `quotes.close-capture`/catch-up's own bookkeeping, not a subscription
 * resolution's), and there is no budget here: COTAHIST is not the brapi quota.
 */

export interface CloseDateRequest {
  readonly assetId: AssetId;
  readonly assetCode: string;
  /** The date whose close (or the nearest earlier one) a resolution needs. */
  readonly upTo: BusinessDate;
}

export interface FetchClosesForDatesPorts {
  readonly source: OfficialCloseSource;
  readonly calendar: TradingCalendar;
  readonly repository: {
    readonly upsertClosePrice: (quote: PriceQuote) => Promise<void>;
    readonly getCloseOnOrBefore: (
      assetId: AssetId,
      date: BusinessDate,
    ) => Promise<{ readonly date: BusinessDate; readonly source: string } | null>;
  };
  readonly clock: Clock;
}

export interface FetchClosesForDatesOptions {
  /** `import.subscription_close_lookback_days` (SPEC-002): how far back a request's window reaches, and how recent a stored close must be for a date to count as already covered. */
  readonly lookbackDays: number;
  readonly annualFileMinDays: number;
}

export interface FetchClosesForDatesSummary {
  /** Closes written to `price_quotes`. */
  readonly fetched: readonly PriceQuote[];
  readonly requests: number;
}

function dayNumber(date: BusinessDate): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  const shifted = new Date((dayNumber(date) + days) * 86_400_000);
  return BusinessDate.of(shifted.toISOString().slice(0, 10));
}

/**
 * AR-19 / idempotent: a date already covered spends no request — a re-import
 * of the same file costs nothing new. Requests are grouped by asset and
 * resolved through `fetchOfficialCloses` in one pass, in deterministic (asset
 * code, then date) order, so a repeated run of the same input reads
 * identically.
 */
export async function fetchClosesForDates(
  ports: FetchClosesForDatesPorts,
  requests: readonly CloseDateRequest[],
  options: FetchClosesForDatesOptions,
): Promise<FetchClosesForDatesSummary> {
  if (requests.length === 0) return { fetched: [], requests: 0 };

  interface AssetGroup {
    readonly assetId: AssetId;
    readonly assetCode: string;
    readonly dates: Set<BusinessDate>;
  }
  const byAsset = new Map<string, AssetGroup>();
  for (const request of requests) {
    const existing = byAsset.get(request.assetId);
    if (existing === undefined) {
      byAsset.set(request.assetId, {
        assetId: request.assetId,
        assetCode: request.assetCode,
        dates: new Set([request.upTo]),
      });
    } else {
      existing.dates.add(request.upTo);
    }
  }
  const orderedGroups = [...byAsset.values()].sort((a, b) => (a.assetCode < b.assetCode ? -1 : 1));

  const wanted: WantedClose[] = [];
  for (const group of orderedGroups) {
    for (const upTo of [...group.dates].sort()) {
      const existingClose = await ports.repository.getCloseOnOrBefore(group.assetId, upTo);
      if (
        existingClose !== null &&
        existingClose.source === ports.source.source &&
        dayNumber(upTo) - dayNumber(existingClose.date) <= options.lookbackDays
      ) {
        continue;
      }
      const from = addDays(upTo, -options.lookbackDays);
      for (let cursor = from; !BusinessDate.isAfter(cursor, upTo); cursor = addDays(cursor, 1)) {
        if (!ports.calendar.isTradingDay(cursor)) continue;
        wanted.push({ assetId: group.assetId, ticker: group.assetCode, date: cursor });
      }
    }
  }

  const currentYear = Number(ports.clock.today().slice(0, 4));
  const result = await fetchOfficialCloses({ source: ports.source }, wanted, {
    annualFileMinDays: options.annualFileMinDays,
    currentYear,
  });

  const fetched: PriceQuote[] = [];
  for (const pair of result.found) {
    const quote: PriceQuote = {
      assetId: pair.assetId,
      date: pair.date,
      close: pair.close,
      source: ports.source.source,
    };
    await ports.repository.upsertClosePrice(quote);
    fetched.push(quote);
  }

  return { fetched, requests: result.requests };
}
