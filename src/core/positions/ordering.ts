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
 * **0 — incoming custody carry.** SPEC-005 BR-005-20c resolves carried cost
 * before asset conversions, so `transfer_in` applies first at the destination.
 * A same-day conversion can then remove the shares and exact basis that
 * arrived there instead of failing against an empty lot. `transfer_out` is
 * deliberately not in this phase: at the source, a same-day buy must enter the
 * average before its cost is carried out (SPEC-005 BR-005-20a / #110).
 *
 * **1 — asset conversions.** SPEC-007 BR-007-05b conversion groups establish
 * the asset and quantity to which every dependent same-day share-base event
 * or trade applies. Ranking both legs first also makes chained conversions
 * deterministic through the existing `(created_at, id)` tie-breaks.
 *
 * **2 — share-base events.** A desdobramento, grupamento or bonificação has an
 * ex-date: from that date the share base is the new one, and a trade printed
 * on that date already prices the new shares. Applying the event first is what
 * makes a same-day buy blend into the correct average. This is the ordering
 * BR-007-15 exists to pin down.
 *
 * **3 — ordinary acquisitions.** Buys and subscriptions.
 *
 * **4 — bonificação fraction removal** (`fracao_bonificacao`, SPEC-007
 * BR-007-05a). After the share-base events, because the fraction only exists
 * once the bonificação has credited it: on a position that held no fraction
 * before the event, removing it first would be refused as removing more than
 * held. And after the day's acquisitions, because a fraction can also *arrive*
 * that day: a `transfer_in` bringing the bonus shares — fraction included —
 * into an institution, followed by B3's *Fração em Ativos* at that
 * institution, would otherwise meet an empty position and be refused
 * (#113 review). Running it later changes no figure in the ordinary case: the
 * removal keeps total cost (BR-007-05a), so removing q shares from (Q, C)
 * before or after an acquisition of (a, c) ends at the same (Q + a − q, C + c)
 * and the same average (C + c) ÷ (Q + a − q).
 *
 * **The one case the two orders differ**: the fraction *is* the whole position
 * (q = Q) and carries cost (C > 0, a bonificação with an attributed value on a
 * flat position). Removed first, it closed the lot and BR-007-07's reset
 * dropped C, so the day's buy opened a fresh lot at (a, c). Removed after the
 * buy, the lot never closes and C stays in it: (a, C + c). The latter is
 * BR-007-05a read literally — a fraction's removal leaves total cost unchanged
 * — and `replay.test.ts` pins it with a worked example.
 *
 * Before adjustments and disposals, so a same-day sale still sees the
 * whole-share base B3's custody shows that day.
 *
 * **5 — adjustments.** Reconciliation corrections, after acquisitions so a
 * negative adjustment nets against the day's purchases rather than against a
 * position that has not been credited yet.
 *
 * **6 — outgoing custody carry and ordinary disposals.** Last, so the day's
 * acquisitions are already in the average a transfer carries or a sale
 * realises against. With date-only granularity there is no
 * intraday order to consult, and incorporating the day's purchases before the
 * day's sales is the convention Brazilian brokers and Receita Federal's
 * average-cost basis both work from. Ranking disposals first would instead
 * refuse a perfectly ordinary same-day buy-then-sell as "selling more than
 * held".
 *
 * **7 — proventos.** Dividends, JCP, rendimentos, amortizações and leilões de
 * frações change no quantity, so their rank cannot affect a figure. They are
 * ranked anyway, because a *total* order is what makes the fold reproducible.
 *
 * #113 inserted rank 2 by shifting adjustments, disposals and proventos up by
 * one, so no pre-existing pair of types changed its relative order
 * (`ordering.test.ts` pins that against the old table).
 * #121 then inserted conversions ahead of the table, shifting every existing
 * rank together and therefore preserving those relative orders again.
 * BR-005-20c subsequently placed the destination's incoming custody carry
 * ahead of conversion. This intentionally moves `transfer_in`; `transfer_out`
 * keeps its disposal-phase rank so BR-005-20a's same-day source buy is carried.
 * Every non-transfer pair keeps its BR-007-15 relative order.
 */
const TYPE_RANK: Readonly<Record<TransactionType, number>> = {
  transfer_in: 0,

  conversion_out: 1,
  conversion_in: 1,

  split: 2,
  grupamento: 2,
  bonificacao: 2,

  buy: 3,
  subscription: 3,

  fracao_bonificacao: 4,

  adjustment: 5,

  sell: 6,
  transfer_out: 6,

  dividend: 7,
  jcp: 7,
  rendimento: 7,
  amortization: 7,
  leilao_fracoes: 7,
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
