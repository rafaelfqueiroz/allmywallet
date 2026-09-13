import type { BusinessDate } from '@/core/shared/clock';
import { hasScheduledBudget } from './budget';
import {
  CloseGapReason,
  type Asset,
  type BudgetCounterPort,
  type Clock,
  type CloseGap,
  type CloseGapRepositoryPort,
  type PriceQuote,
  type QuoteProvider,
  type QuoteRepositoryPort,
} from './ports';

export interface BackfillPorts {
  readonly repository: QuoteRepositoryPort;
  readonly provider: QuoteProvider;
  readonly budgetCounter: BudgetCounterPort;
  readonly gaps: CloseGapRepositoryPort;
  readonly clock: Clock;
}

export interface BackfillOptions {
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
}

export interface BackfillSummary {
  /** Closes written to `price_quotes`, in the order they were written (asset code, then date). */
  readonly recovered: readonly PriceQuote[];
  /** Days recorded as gaps (BR-021-31). */
  readonly gaps: readonly CloseGap[];
  /** Provider requests made — each one charged to the scheduled budget (BR-021-32). */
  readonly requests: number;
}

/**
 * SPEC-021 BR-021-29/31/32/33 — recover the closes a stopped worker missed.
 *
 * For each asset, the days in `days` that have no `price_quotes` row are asked
 * of the provider's history in **one** request spanning the first to the last
 * missing day. Every requested day then ends in exactly one of two states:
 *
 *   - a close was supplied → written to `price_quotes`, and any gap an earlier
 *     start recorded for that day is cleared;
 *   - it was not → recorded as a gap, with the reason. Never interpolated from
 *     its neighbours and never copied from the day before (BR-021-31): a gap
 *     row is the honest record, and SPEC-009's carry-forward is what values the
 *     day, visibly marked as such.
 *
 * **Budget (BR-021-32).** Checked with `hasScheduledBudget` before each
 * request and charged to `'scheduled'` after each successful one — exactly as
 * `pollHeldAsset` does, so SPEC-008's on-demand reserve (BR-008-20) stays a
 * wall catch-up cannot climb, and `budget.check`'s cadence degradation
 * (BR-008-22) sees catch-up's spend like any other scheduled request. An asset
 * the budget cannot cover has every one of its missing days recorded as a gap.
 *
 * **What this never touches (BR-021-33).** `latest_quotes` is not written —
 * `upsertLatestQuote` is never called — and nothing here enqueues an
 * opportunity evaluation or holds a notifier. SPEC-018 evaluates rules against
 * the latest quote only, so a crossing recovered from last Tuesday's close is
 * structurally invisible to it, not merely skipped.
 *
 * AR-19: idempotent. A day that already has a close is not requested again, so
 * a second start in a row spends nothing on the days the first one recovered.
 */
export async function backfillMissedCloses(
  ports: BackfillPorts,
  assets: readonly Asset[],
  days: readonly BusinessDate[],
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const recovered: PriceQuote[] = [];
  const gaps: CloseGap[] = [];
  let requests = 0;
  const yearMonth = ports.clock.today().slice(0, 7);

  // Determinism: the same holdings always spend the budget in the same order,
  // so which asset a nearly-exhausted budget covers is reproducible.
  const ordered = [...assets].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const ascendingDays = [...days].sort();

  for (const asset of ordered) {
    const missing: BusinessDate[] = [];
    for (const day of ascendingDays) {
      if ((await ports.repository.getClosePrice(asset.id, day)) === null) missing.push(day);
    }
    const first = missing[0];
    const last = missing.at(-1);
    if (first === undefined || last === undefined) continue;

    const recordAll = async (reason: CloseGapReason): Promise<void> => {
      for (const date of missing) {
        const gap: CloseGap = { assetId: asset.id, date, reason };
        await ports.gaps.recordGap(gap);
        gaps.push(gap);
      }
    };

    const usage = await ports.budgetCounter.getUsage(yearMonth);
    if (!hasScheduledBudget(usage, options.monthlyQuota, options.ondemandReservePct)) {
      await recordAll(CloseGapReason.BUDGET_EXHAUSTED);
      continue;
    }

    const fetched = await ports.provider.fetchHistoricalCloses(asset.code, first, last);
    if (!fetched.ok) {
      await recordAll(CloseGapReason.PROVIDER_UNAVAILABLE);
      continue;
    }
    requests += 1;
    await ports.budgetCounter.increment(yearMonth, 'scheduled');

    const byDate = new Map(fetched.value.closes.map((entry) => [entry.date, entry.close]));
    for (const date of missing) {
      const close = byDate.get(date);
      if (close === undefined) {
        const gap: CloseGap = { assetId: asset.id, date, reason: CloseGapReason.NOT_SUPPLIED };
        await ports.gaps.recordGap(gap);
        gaps.push(gap);
        continue;
      }
      const quote: PriceQuote = { assetId: asset.id, date, close, source: fetched.value.source };
      await ports.repository.upsertClosePrice(quote);
      await ports.gaps.clearGap(asset.id, date);
      recovered.push(quote);
    }
  }

  return { recovered, gaps, requests };
}
