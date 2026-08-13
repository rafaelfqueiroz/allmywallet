import { BusinessDate } from '@/core/shared/clock';
import type { Transaction, TransactionType } from '@/core/ledger/transaction';

/**
 * SPEC-007 BR-007-15: corporate events apply in correct chronological order
 * relative to trades. **This file is part of the algorithm, not an
 * implementation detail** — a split processed after a same-day buy silently
 * corrupts every subsequent average, and nothing downstream will ever notice.
 *
 * The ledger carries dates, not timestamps (AR-29), so same-day rows need a
 * deterministic order that does not depend on insertion order, page order, or
 * whatever the database felt like returning. That is what `TYPE_RANK` is.
 */

/**
 * Rank within a single trade date. Lower applies first.
 *
 * **0 — share-base events.** A desdobramento, grupamento or bonificação has an
 * ex-date: from that date the share base is the new one, and a trade printed
 * on that date already prices the new shares. Applying the event first is what
 * makes a same-day buy blend into the correct average. This is the ordering
 * BR-007-15 exists to pin down.
 *
 * **1 — acquisitions.** Buys, subscriptions and shares arriving by transfer.
 *
 * **2 — adjustments.** Reconciliation corrections, after acquisitions so a
 * negative adjustment nets against the day's purchases rather than against a
 * position that has not been credited yet.
 *
 * **3 — disposals.** Last, so the day's acquisitions are already in the
 * average a sale realises against. With date-only granularity there is no
 * intraday order to consult, and incorporating the day's purchases before the
 * day's sales is the convention Brazilian brokers and Receita Federal's
 * average-cost basis both work from. Ranking disposals first would instead
 * refuse a perfectly ordinary same-day buy-then-sell as "selling more than
 * held".
 *
 * **4 — proventos.** Dividends, JCP, rendimentos and amortizações change no
 * quantity, so their rank cannot affect a figure. They are ranked anyway,
 * because a *total* order is what makes the fold reproducible.
 */
const TYPE_RANK: Readonly<Record<TransactionType, number>> = {
  split: 0,
  grupamento: 0,
  bonificacao: 0,

  buy: 1,
  subscription: 1,
  transfer_in: 1,

  adjustment: 2,

  sell: 3,
  transfer_out: 3,

  dividend: 4,
  jcp: 4,
  rendimento: 4,
  amortization: 4,
};

export function typeRank(type: TransactionType): number {
  return TYPE_RANK[type];
}

/**
 * The replay order: `(trade_date, type_rank, created_at, id)`.
 *
 * The last key is not decoration. A committed import inserts thousands of rows
 * inside one transaction, so `created_at` ties are the common case rather than
 * the exotic one; without a final tiebreak the fold's result would depend on
 * the database's row order and "rebuild equals incremental" (DM-4) would fail
 * intermittently rather than never. Ids are UUIDv7 (AR-25), which are
 * time-ordered, so this key extends `created_at` rather than contradicting it.
 */
export function compareForReplay(a: Transaction, b: Transaction): number {
  const byDate = BusinessDate.compare(a.tradeDate, b.tradeDate);
  if (byDate !== 0) return byDate;

  const byRank = typeRank(a.type) - typeRank(b.type);
  if (byRank !== 0) return byRank;

  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * SPEC-006 BR-006-18 / TS-07: sorting rather than appending is what makes a
 * backdated row behave as though it had always been there. Copies first —
 * mutating a caller's array in place would make the fold's result depend on
 * how many times it had been run.
 */
export function sortForReplay(transactions: readonly Transaction[]): readonly Transaction[] {
  return [...transactions].sort(compareForReplay);
}
