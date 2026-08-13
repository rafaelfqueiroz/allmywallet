import { isQuoteStale } from './staleness';
import { hasScheduledBudget } from './budget';
import type { Asset, BudgetCounterPort, Clock, QuoteProvider, QuoteRepositoryPort } from './ports';

export interface PollAssetPorts {
  readonly repository: QuoteRepositoryPort;
  readonly provider: QuoteProvider;
  readonly budgetCounter: BudgetCounterPort;
  readonly clock: Clock;
}

export interface PollAssetOptions {
  readonly cadenceMinutes: number;
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
}

export interface PollAssetResult {
  readonly asset: Asset;
  readonly outcome: 'polled' | 'already_fresh' | 'skipped_budget' | 'failed';
}

/**
 * SPEC-008 BR-008-05: one asset's poll, called by the `quotes.poll` handler
 * only while the session is open (the caller's job, not this function's —
 * see `worker/handlers/quotes.ts`'s AR-18 gate).
 *
 * AR-19: idempotent under pg-boss retry. A retried job for the same asset
 * within the same cadence window finds `already_fresh` from the previous
 * successful attempt and makes **no** second provider call — this is what
 * stops a retry from double-spending budget, not a dedup table.
 */
export async function pollHeldAsset(
  ports: PollAssetPorts,
  asset: Asset,
  options: PollAssetOptions,
): Promise<PollAssetResult> {
  const now = ports.clock.now();
  const stored = await ports.repository.getLatestQuote(asset.id);
  if (stored && !isQuoteStale(true, options.cadenceMinutes, now, stored.fetchedAt)) {
    return { asset, outcome: 'already_fresh' };
  }

  const yearMonth = ports.clock.today().slice(0, 7);
  const usage = await ports.budgetCounter.getUsage(yearMonth);
  // BR-008-22/BR-008-24: if the schedule genuinely cannot afford this call,
  // skip it — the stale stored value (if any) is what BR-008-24 shows.
  if (!hasScheduledBudget(usage, options.monthlyQuota, options.ondemandReservePct)) {
    return { asset, outcome: 'skipped_budget' };
  }

  const fetched = await ports.provider.fetchQuote(asset.code);
  if (!fetched.ok) {
    // BR-008-27: retried with backoff by the queue policy, not looped here.
    return { asset, outcome: 'failed' };
  }

  await ports.repository.upsertLatestQuote({
    assetId: asset.id,
    price: fetched.value.price,
    quotedAt: fetched.value.quotedAt,
    fetchedAt: now,
    source: fetched.value.source,
  });
  await ports.budgetCounter.increment(yearMonth, 'scheduled');
  return { asset, outcome: 'polled' };
}
