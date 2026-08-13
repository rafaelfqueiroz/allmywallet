import type { Asset, BudgetCounterPort, Clock, QuoteProvider, QuoteRepositoryPort } from './ports';

export interface CaptureClosePorts {
  readonly repository: QuoteRepositoryPort;
  readonly provider: QuoteProvider;
  readonly budgetCounter: BudgetCounterPort;
  readonly clock: Clock;
}

export interface CaptureCloseResult {
  readonly asset: Asset;
  readonly outcome: 'captured' | 'already_captured' | 'failed';
}

/**
 * SPEC-008 BR-008-09/DL-008-08: the one deliberate call outside session
 * hours — the official closing price. It supersedes the last intraday quote
 * and is what gets written to history (`price_quotes`), never rewriting a
 * different day's row (BR-008-10 — `upsertClosePrice` is keyed on
 * `(assetId, date)`).
 *
 * AR-19: idempotent under retry — `getClosePrice` first means a retried job
 * for a date already captured makes no second provider call, so budget is
 * never double-spent on a retry.
 */
export async function captureClosePrice(
  ports: CaptureClosePorts,
  asset: Asset,
): Promise<CaptureCloseResult> {
  const date = ports.clock.today();
  const existing = await ports.repository.getClosePrice(asset.id, date);
  if (existing) {
    return { asset, outcome: 'already_captured' };
  }

  const fetched = await ports.provider.fetchQuote(asset.code);
  if (!fetched.ok) {
    return { asset, outcome: 'failed' };
  }

  await ports.repository.upsertClosePrice({
    assetId: asset.id,
    date,
    close: fetched.value.price,
    source: fetched.value.source,
  });
  await ports.budgetCounter.increment(date.slice(0, 7), 'scheduled');
  return { asset, outcome: 'captured' };
}
