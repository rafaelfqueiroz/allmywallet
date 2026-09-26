import type { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { hasScheduledBudget } from '@/core/quotes/budget';
import type { BudgetCounterPort, Clock, PriceQuote, QuoteProvider } from '@/core/quotes/ports';

/**
 * SPEC-005 BR-005-20d (#144) / DL-005-22 — fetch and store the closes a
 * subscription resolution needs, ahead of the commit that reads them
 * (`ClosePriceReader.closeOnOrBefore`).
 *
 * One request per **credit date actually needed**, for a short window ending
 * at that date — enough to cross a weekend or a B3 holiday and still land on
 * a real close, never the unbounded history `backfillMissedCloses` recovers
 * for worker-start catch-up. `ClosePriceReader` itself carries no lookback
 * bound (D2: the nearest earlier stored close, however old) — this only
 * decides how far a single provider request reaches back, and which dates get
 * one at all, not how far a commit may later look for what it wrote.
 *
 * #144 review F2 — two dates on the *same* asset are genuinely different
 * questions ("what closed XPML11 on 2024-02-22" is not "what closed it on
 * 2025-06-10"), so a plain per-asset dedupe that kept only the latest date
 * silently starved every earlier one, and a stale close from an unrelated
 * earlier round wrongly suppressed a fetch for a later date it does not
 * price. Both are fixed below: dates are tracked individually, and "already
 * covered" means a close on the date itself or within the fetch window just
 * before it — never any close, however old.
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
  /** Calendar days of history requested before each date (default 10 — comfortably past a long holiday run). */
  readonly lookbackDays?: number;
}

export interface FetchClosesForDatesSummary {
  /** Closes written to `price_quotes`. */
  readonly fetched: readonly PriceQuote[];
  /** Provider requests made — each charged to the scheduled budget (BR-021-32's pattern, reused here). */
  readonly requests: number;
}

const DEFAULT_LOOKBACK_DAYS = 10;

function dayNumber(date: BusinessDate): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function addDays(date: BusinessDate, days: number): BusinessDate {
  const shifted = new Date((dayNumber(date) + days) * 86_400_000);
  return BusinessDate.of(shifted.toISOString().slice(0, 10));
}

interface AssetGroup {
  readonly assetId: AssetId;
  readonly assetCode: string;
  readonly dates: Set<BusinessDate>;
}

/**
 * AR-19 / idempotent: a date already covered by a close on it, or within the
 * fetch window just before it, spends no budget and makes no request — a
 * re-import of the same file costs nothing new. An older, out-of-window close
 * (a stale price from an earlier subscription round on the same asset) does
 * **not** suppress a fetch for a later date (#144 review F2) — the whole
 * point of asking again is that the earlier close does not price the later
 * date.
 *
 * Several dates on one asset are merged into as few requests as possible —
 * cheaper than one per date — but only when one request's own window
 * genuinely covers both; each request's span never widens past
 * `lookbackDays` to force a merge that would not otherwise fit.
 *
 * Never fatal to the caller: a provider failure or an exhausted budget simply
 * fetches nothing for that date, exactly as `backfillMissedCloses` leaves a
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

  // Group by asset, keeping every distinct date needed — not only the latest.
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
  const ordered = [...byAsset.values()].sort((a, b) => (a.assetCode < b.assetCode ? -1 : 1));

  for (const group of ordered) {
    // Which of this asset's dates still need a close: not one already stored
    // on the date itself or within the fetch window just before it.
    const needed: BusinessDate[] = [];
    for (const date of [...group.dates].sort()) {
      const existingClose = await ports.repository.getCloseOnOrBefore(group.assetId, date);
      if (
        existingClose !== null &&
        dayNumber(date) - dayNumber(existingClose.date) <= lookbackDays
      ) {
        continue;
      }
      needed.push(date);
    }
    if (needed.length === 0) continue;

    // Greedily merge from the latest date backward: a request ending at a
    // date, with the standard lookback window, absorbs any earlier needed
    // date that window already reaches — cheaper than one request each,
    // without ever widening a window past `lookbackDays` to force a merge.
    const descending = [...needed].sort().reverse();
    const covered = new Set<BusinessDate>();
    for (const date of descending) {
      if (covered.has(date)) continue;

      const usage = await ports.budgetCounter.getUsage(yearMonth);
      if (!hasScheduledBudget(usage, options.monthlyQuota, options.ondemandReservePct)) continue;

      const from = addDays(date, -lookbackDays);
      const result = await ports.provider.fetchHistoricalCloses(group.assetCode, from, date);
      if (!result.ok) continue;
      requestsMade += 1;
      await ports.budgetCounter.increment(yearMonth, 'scheduled');

      for (const entry of result.value.closes) {
        const quote: PriceQuote = {
          assetId: group.assetId,
          date: entry.date,
          close: entry.close,
          source: result.value.source,
        };
        await ports.repository.upsertClosePrice(quote);
        fetched.push(quote);
      }
      for (const other of needed) {
        const span = dayNumber(date) - dayNumber(other);
        if (span >= 0 && span <= lookbackDays) covered.add(other);
      }
    }
  }

  return { fetched, requests: requestsMade };
}
