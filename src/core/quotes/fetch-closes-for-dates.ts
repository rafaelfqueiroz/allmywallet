import type { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { hasScheduledBudget } from '@/core/quotes/budget';
import type { BudgetCounterPort, Clock, PriceQuote, QuoteProvider } from '@/core/quotes/ports';

/**
 * SPEC-005 BR-005-20d (#144) / DL-005-22 — fetch and store the closes a
 * subscription resolution needs, ahead of the commit that reads them
 * (`ClosePriceReader.closeOnOrBefore`).
 *
 * One request per **main asset**, for a short window ending at the credit
 * date — enough to cross a weekend or a B3 holiday and still land on a real
 * close, never the unbounded history `backfillMissedCloses` recovers for
 * worker-start catch-up. `ClosePriceReader` itself carries no lookback bound
 * (D2: the nearest earlier stored close, however old) — this only decides how
 * far a single provider request reaches back, not how far a commit may later
 * look for what it wrote.
 */

export interface CloseDateRequest {
  readonly assetId: AssetId;
  readonly assetCode: string;
  /** The date whose close (or the nearest earlier one) a resolution needs. */
  readonly upTo: BusinessDate;
}

export interface FetchClosesForDatesPorts {
  readonly repository: {
    readonly upsertClosePrice: (quote: PriceQuote) => Promise<void>;
    readonly getCloseOnOrBefore: (
      assetId: AssetId,
      date: BusinessDate,
    ) => Promise<{ readonly date: BusinessDate } | null>;
  };
  readonly provider: QuoteProvider;
  readonly budgetCounter: BudgetCounterPort;
  readonly clock: Clock;
}

export interface FetchClosesForDatesOptions {
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
  /** Calendar days of history requested before each `upTo` (default 10 — comfortably past a long holiday run). */
  readonly lookbackDays?: number;
}

export interface FetchClosesForDatesSummary {
  /** Closes written to `price_quotes`. */
  readonly fetched: readonly PriceQuote[];
  /** Provider requests made — each charged to the scheduled budget (BR-021-32's pattern, reused here). */
  readonly requests: number;
}

const DEFAULT_LOOKBACK_DAYS = 10;

function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return BusinessDate.of(shifted.toISOString().slice(0, 10));
}

/**
 * AR-19 / idempotent: an asset already holding a close on or before its
 * requested date spends no budget and makes no request — a re-import of the
 * same file, or two subscriptions on the same issuer in one batch, costs at
 * most one request per distinct main asset.
 *
 * Never fatal to the caller: a provider failure or an exhausted budget simply
 * fetches nothing for that asset, exactly as `backfillMissedCloses` leaves a
 * day unrecovered — the commit that follows finds no stored close and leaves
 * the pair `unclassified` for a later import (BR-005-20d).
 */
export async function fetchClosesForDates(
  ports: FetchClosesForDatesPorts,
  requests: readonly CloseDateRequest[],
  options: FetchClosesForDatesOptions,
): Promise<FetchClosesForDatesSummary> {
  const fetched: PriceQuote[] = [];
  let requestsMade = 0;
  const yearMonth = ports.clock.today().slice(0, 7);
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // One request per distinct asset, at the latest `upTo` any pairing needs —
  // a wider window covers every earlier one, and determinism (same order
  // every run) matters no more here than it does for the daily poller: two
  // distinct assets never race each other for the same budget slot twice.
  const byAsset = new Map<string, CloseDateRequest>();
  for (const request of requests) {
    const existing = byAsset.get(request.assetId);
    if (existing === undefined || BusinessDate.isAfter(request.upTo, existing.upTo)) {
      byAsset.set(request.assetId, request);
    }
  }
  const ordered = [...byAsset.values()].sort((a, b) => (a.assetCode < b.assetCode ? -1 : 1));

  for (const request of ordered) {
    if ((await ports.repository.getCloseOnOrBefore(request.assetId, request.upTo)) !== null) {
      continue;
    }
    const usage = await ports.budgetCounter.getUsage(yearMonth);
    if (!hasScheduledBudget(usage, options.monthlyQuota, options.ondemandReservePct)) continue;

    const from = addDays(request.upTo, -lookbackDays);
    const result = await ports.provider.fetchHistoricalCloses(
      request.assetCode,
      from,
      request.upTo,
    );
    if (!result.ok) continue;
    requestsMade += 1;
    await ports.budgetCounter.increment(yearMonth, 'scheduled');

    for (const entry of result.value.closes) {
      const quote: PriceQuote = {
        assetId: request.assetId,
        date: entry.date,
        close: entry.close,
        source: result.value.source,
      };
      await ports.repository.upsertClosePrice(quote);
      fetched.push(quote);
    }
  }

  return { fetched, requests: requestsMade };
}
