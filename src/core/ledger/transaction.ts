import type { BusinessDate } from '@/core/shared/clock';
import type {
  AssetId,
  ConversionGroupId,
  ImportBatchId,
  InstitutionId,
  TransactionId,
  UserId,
} from '@/core/shared/ids';
import { Money, type Quantity } from '@/core/shared/money';

/**
 * SPEC-006 — the transaction entity.
 *
 * BR-006-01: this is the single source of truth. `Position`,
 * `DailyValuationSnapshot` and every report figure are derived from it and
 * rebuildable from it alone (DM-4). Nothing downstream may hold state that
 * cannot be reproduced by replaying these rows.
 */

/**
 * SPEC-006 BR-006-05: the seventeen supported types, and no others.
 *
 * The last two arrived with #113 and are appended rather than slotted in, so
 * no existing index moves:
 *
 *   - `leilao_fracoes` — the cash B3 pays for a bonificação fraction it sold at
 *     auction. A provento (SPEC-014 BR-014-01, DL-014-08), not a sale.
 *   - `fracao_bonificacao` — the fractional quantity a bonificação left behind,
 *     removed at unchanged total cost with no realised gain (SPEC-007
 *     BR-007-05a). A split or grupamento fraction is **not** this type: it is a
 *     plain `sell` at the auction value (BR-007-04b, DL-007-09).
 */
export const TRANSACTION_TYPES = [
  'buy',
  'sell',
  'dividend',
  'jcp',
  'rendimento',
  'amortization',
  'split',
  'grupamento',
  'bonificacao',
  'subscription',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'leilao_fracoes',
  'fracao_bonificacao',
  'conversion_out',
  'conversion_in',
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * SPEC-006 BR-006-05: conversion legs are internal members of an atomic
 * group. Generic single-row forms may display them in history, but must never
 * offer them as standalone create/edit/classification choices.
 */
export type UserEditableTransactionType = Exclude<
  TransactionType,
  'conversion_out' | 'conversion_in'
>;

export const USER_EDITABLE_TRANSACTION_TYPES = TRANSACTION_TYPES.filter(
  (type): type is UserEditableTransactionType =>
    type !== 'conversion_out' && type !== 'conversion_in',
) as unknown as readonly [UserEditableTransactionType, ...UserEditableTransactionType[]];

/**
 * SPEC-006 BR-006-03: only `active` rows enter calculations.
 *
 * `unclassified` is stored deliberately rather than rejected (DL-006-06): the
 * row stays visible so reconciliation is honest, while staying out of the
 * arithmetic so figures stay correct. `superseded` is what a re-import leaves
 * behind when it replaces a row.
 */
export const TRANSACTION_STATUSES = ['active', 'unclassified', 'superseded'] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface Transaction {
  readonly id: TransactionId;
  readonly userId: UserId;
  readonly assetId: AssetId;
  /**
   * BR-007-08: positions are tracked per `(user, asset, institution)`. Null
   * where the source did not name one — a manual entry for an asset held
   * directly, for instance — which is a distinct bucket, not a wildcard.
   */
  readonly institutionId: InstitutionId | null;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  /**
   * AR-29: a `date`, never a timestamp. A trade on 2026-03-15 in São Paulo is
   * that date regardless of the reader's timezone; a timestamp invites an
   * off-by-one that shifts transactions across period boundaries and corrupts
   * every report.
   */
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  /**
   * A persisted derivation, for the history list, filters and CSV export only
   * (BR-006-07..10). **The position engine never reads it** — it recomputes
   * from `quantity`, `unitPrice`, `fees` and `ratio`, so a stale or
   * hand-edited denormalisation can never reach a *preço médio*.
   */
  readonly totalValue: Money;
  /**
   * SPEC-007 BR-007-04: the ratio a split or grupamento multiplies quantity
   * by — 2 for a 1:2 desdobramento, 0.1 for a 10:1 grupamento. Null for every
   * other type; a database CHECK enforces the pairing (AR-30).
   */
  readonly ratio: Quantity | null;
  /**
   * SPEC-006 BR-006-05: every conversion leg belongs to one atomic group.
   * Null for every non-conversion transaction.
   */
  readonly conversionGroupId: ConversionGroupId | null;
  /**
   * SPEC-006 BR-006-05 / SPEC-007 BR-007-05b: exact cost moved by a
   * conversion leg. Required on both conversion directions and null for
   * ordinary rows. Persisting the same exact amount on the outgoing leg and
   * its allocated incoming peer prevents independent rounding at replay.
   */
  readonly costBasis: Money | null;
  /** BR-006-04: unique per user together with `occurrence`. */
  readonly naturalKey: string;
  /**
   * BR-006-04 / TS-21: two genuinely identical same-day trades are a real
   * thing B3 extracts contain. The occurrence counter is what lets both exist
   * without the uniqueness constraint collapsing them into one.
   */
  readonly occurrence: number;
  /** BR-006-02: provenance — the originating batch, or null for manual entry. */
  readonly importBatchId: ImportBatchId | null;
  readonly isManual: boolean;
  /**
   * BR-006-16: set when an imported row is edited. A later re-import must not
   * overwrite the correction (SPEC-005 consumes this).
   */
  readonly isUserModified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Types that move quantity or cost basis. Everything else is recognised
 * elsewhere: dividends, JCP, rendimentos, amortizações and leilões de frações
 * are proventos (SPEC-014), recognised at pay date and never assumed
 * reinvested, so they leave the position untouched.
 */
const POSITION_AFFECTING_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'buy',
  'sell',
  'split',
  'grupamento',
  'bonificacao',
  'subscription',
  'transfer_in',
  'transfer_out',
  'adjustment',
  // SPEC-007 BR-007-05a: quantity leaves; total cost stays.
  'fracao_bonificacao',
  // SPEC-007 BR-007-05b: both linked legs change positions without cash.
  'conversion_out',
  'conversion_in',
]);

export function affectsPosition(type: TransactionType): boolean {
  return POSITION_AFFECTING_TYPES.has(type);
}

/** SPEC-014's proventos. Listed here because BR-006-05 names them as types. */
const EARNINGS_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'dividend',
  'jcp',
  'rendimento',
  'amortization',
  // SPEC-014 BR-014-01 / DL-014-08: a bonificação fraction's auction cash.
  'leilao_fracoes',
]);

export function isEarnings(type: TransactionType): boolean {
  return EARNINGS_TYPES.has(type);
}

/** BR-007-04: the two types whose effect is expressed as a ratio. */
const RATIO_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>(['split', 'grupamento']);

export function requiresRatio(type: TransactionType): boolean {
  return RATIO_TYPES.has(type);
}

/** SPEC-006 BR-006-03 / SPEC-007 BR-007-16: only `active` rows are calculated on. */
export function isActive(transaction: Transaction): boolean {
  return transaction.status === 'active';
}

/**
 * The signed cash effect of a row, stored on the ledger for the history list
 * and CSV export. A purchase costs quantity × price *plus* fees; a disposal
 * yields quantity × price *minus* them.
 *
 * Worked example (DV-17): 100 PETR4 at R$ 32,15 with R$ 4,90 of fees is
 * 100 × 32,15 = 3.215,00 plus 4,90 = **3.219,90** on a buy, and
 * 3.215,00 − 4,90 = **3.210,10** on a sell.
 *
 * SPEC-007 BR-007-05a: a `fracao_bonificacao` moves no cash, so its total is
 * **zero** whatever price or fees the row carries. The cash for the fraction
 * is the separate `leilao_fracoes` provento (SPEC-014 BR-014-01); a total here
 * would show the same money twice in the history list and the export — once
 * as the removal, once as the auction — and read as income twice. The
 * position engine never reads either field for this type
 * (`core/positions/apply-transaction.ts`), so the zero changes no figure.
 * Worked example: removing 0,2 ITSA4 entered at 14,00 is 0, not 0,2 × 14,00 =
 * 2,80; the 2,80 lives on the leilão row alone.
 */
export function computeTotalValue(
  type: TransactionType,
  quantity: Quantity,
  unitPrice: Money,
  fees: Money,
): Money {
  if (type === 'fracao_bonificacao' || type === 'conversion_out' || type === 'conversion_in') {
    return Money.zero();
  }
  const gross = unitPrice.times(quantity);
  if (type === 'sell' || type === 'transfer_out') return gross.minus(fees);
  return gross.plus(fees);
}
