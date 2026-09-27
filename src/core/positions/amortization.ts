import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { AssetIdentity, TransactionRepository } from '@/core/ledger/ports';
import { type PayoutSchedule, payoutScheduleOf } from '@/core/quotes/tesouro-title';
import { makePosition, type PositionState } from '@/core/positions/position-state';
import { amortizationNotSupported, amortizationOutsideSchedule } from '@/core/positions/errors';

/**
 * SPEC-007 BR-007-05c / DL-007-13 — **an amortization returns capital.**
 *
 * Quantity is unchanged and total cost falls by the *principal* returned; the
 * average is recomputed. What the principal is depends on the asset:
 *
 *   - a **listed asset** (a stock's *restituição de capital*, a FII's
 *     *amortização*) — the whole amount received;
 *   - a **Tesouro Educa+ or Renda+ title (NTN-B1)**, whose monthly payments
 *     are principal plus yield — the remaining total cost ÷ the payments
 *     remaining including this one; the rest of the payment is yield.
 *
 * Total cost never goes below zero: an amount above the remaining cost is
 * realized gain (BR-007-09).
 *
 * The amortization row stays a provento as well (SPEC-014 BR-014-01): the
 * Earnings report still shows the cash. This module moves the cost basis the
 * cash came out of, nothing else.
 */

/** How much of an amortization of one asset is principal. */
export type AmortizationBasis =
  /** BR-007-05c: a listed asset — the whole amount received. */
  | { readonly kind: 'whole_amount' }
  /** BR-007-05c: an NTN-B1 title — remaining cost ÷ payments remaining. */
  | { readonly kind: 'installments'; readonly schedule: PayoutSchedule }
  /**
   * An asset BR-007-05c gives no principal for — a Tesouro title that is not
   * NTN-B1, or bank paper. Refused rather than given an invented one.
   */
  | { readonly kind: 'unsupported' };

/**
 * The basis of every asset a replay may meet an amortization of. An asset
 * absent from the map is **unknown**, and its amortization fails the replay
 * (`AMORTIZATION_TERMS_UNKNOWN`) instead of defaulting to a rule that is wrong
 * for one of the two kinds.
 */
export type AmortizationTerms = ReadonlyMap<AssetId, AmortizationBasis>;

/** Stock, FII, BDR and ETF — the classes that trade on the exchange. */
const LISTED_CLASSES: ReadonlySet<string> = new Set(['stock', 'fii', 'bdr', 'etf']);

/**
 * SPEC-007 BR-007-05c — the basis for one asset, from its catalogue class and
 * code.
 *
 * The class decides first, so a ticker can never be read as a Tesouro code.
 * A Tesouro title has a schedule only when its code names an Educa+ or
 * Renda+ (`payoutScheduleOf`); every other Tesouro title, and every CDB, LCI
 * and LCA, is `unsupported`. The spec names no principal for them, and each
 * plausible default is a fabrication: the whole payment would count yield as
 * returned capital, and zero is the v1 behaviour DL-007-13 replaced.
 */
export function amortizationBasisOf(asset: AssetIdentity): AmortizationBasis {
  if (LISTED_CLASSES.has(asset.assetClass)) return { kind: 'whole_amount' };
  if (asset.assetClass !== 'tesouro_direto') return { kind: 'unsupported' };
  const schedule = payoutScheduleOf(asset.code);
  return schedule === null ? { kind: 'unsupported' } : { kind: 'installments', schedule };
}

export function amortizationTermsOf(assets: Iterable<AssetIdentity>): AmortizationTerms {
  const terms = new Map<AssetId, AmortizationBasis>();
  for (const asset of assets) terms.set(asset.assetId, amortizationBasisOf(asset));
  return terms;
}

/**
 * The terms for a use case about to replay part of the ledger: every asset
 * the ledger holds an amortization of, and `including` — the assets of rows
 * the use case is about to add (`TransactionRepository.describeAmortizedAssets`).
 */
export async function loadAmortizationTerms(
  transactions: Pick<TransactionRepository, 'describeAmortizedAssets'>,
  including: readonly AssetId[],
): Promise<AmortizationTerms> {
  return amortizationTermsOf(await transactions.describeAmortizedAssets(including));
}

/** Months since year 0 — a year and a month, the only integers in play. */
function monthIndex(date: BusinessDate): number {
  const [year = '', month = ''] = date.split('-');
  return Number(year) * 12 + Number(month) - 1;
}

function dateAtMonthIndex(index: number, day: string): BusinessDate {
  const year = String(Math.floor(index / 12)).padStart(4, '0');
  const month = String((index % 12) + 1).padStart(2, '0');
  return `${year}-${month}-${day}` as BusinessDate;
}

/** The date of the schedule's last payment — its maturity. */
export function lastPaymentOf(schedule: PayoutSchedule): BusinessDate {
  const [, , day = ''] = schedule.firstPayment.split('-');
  return dateAtMonthIndex(monthIndex(schedule.firstPayment) + schedule.installments - 1, day);
}

/**
 * SPEC-007 BR-007-05c — the payments remaining **including** the one paid on
 * `date`, or `null` when `date` falls outside the schedule.
 *
 * A payment is identified by its **month**, not its day: each falls on the
 * 15th or, when that is not a business day, the next one, which is never in
 * the following month. So `remaining = n − (months from the first payment's
 * month to date's month)`.
 *
 * Worked example (DV-17), Educa+ 2026 (60 from 2026-01-15):
 *   2026-01-15 → 0 months elapsed → 60 remaining
 *   2026-02-16 (the 15th is a Sunday) → 1 month → 59
 *   2030-12-15 → 59 months → 1, the last payment
 *   2025-12-15 → −1 month  → null (before the first)
 *   2031-01-15 → 60 months → null (after the last)
 */
export function installmentsRemaining(schedule: PayoutSchedule, date: BusinessDate): number | null {
  const elapsed = monthIndex(date) - monthIndex(schedule.firstPayment);
  if (elapsed < 0 || elapsed >= schedule.installments) return null;
  return schedule.installments - elapsed;
}

export interface AmortizationInput {
  /** The cash received — the amount the Earnings report shows for the row. */
  readonly received: Money;
  readonly basis: AmortizationBasis;
  readonly date: BusinessDate;
}

/**
 * SPEC-007 BR-007-05c — apply one amortization to a position.
 *
 * Worked example, listed (DV-17) — 240 VIVT3 at a total cost of 5.697,02
 * (average 23,73758333…) receive a restituição de capital of 1,2265 a share:
 *
 *   principal  = 1,2265 × 240             =   294,36   (the whole amount)
 *   total cost = 5.697,02 − 294,36        = 5.402,66
 *   average    = 5.402,66 ÷ 240           =    22,51108333…
 *   quantity 240 and realized gain unchanged.
 *
 * Worked example, NTN-B1 — 2 Educa+ 2026 bought for 6.000,00 in all:
 *
 *   2026-01-15, 60 remaining: principal 6.000,00 ÷ 60 = 100,00 → 5.900,00
 *   2026-02-16, 59 remaining: principal 5.900,00 ÷ 59 = 100,00 → 5.800,00
 *   …
 *   2030-12-15,  1 remaining: principal = the whole remaining cost → 0
 *
 * whatever each payment was: the part above 100,00 is yield, which stays in
 * the Earnings report and never touches the cost basis.
 *
 * Refusals, each a `DomainError` rather than a figure (the engine's rule for a
 * row it cannot apply, as a split without a ratio is):
 *
 *   - `AMORTIZATION_NOT_SUPPORTED` — the asset has no BR-007-05c principal;
 *   - `AMORTIZATION_OUTSIDE_SCHEDULE` — an NTN-B1 payment dated before its
 *     title's first payment or after its last has no "payments remaining
 *     including this one": zero would divide by nothing, and any other count
 *     would be invented.
 */
export function applyAmortization(
  state: PositionState,
  input: AmortizationInput,
): Result<PositionState, DomainError> {
  const { basis, date } = input;
  switch (basis.kind) {
    case 'whole_amount':
      return ok(returnCapital(state, input.received));
    case 'installments': {
      const remaining = installmentsRemaining(basis.schedule, date);
      if (remaining === null) {
        return err(
          amortizationOutsideSchedule(
            date,
            basis.schedule.firstPayment,
            lastPaymentOf(basis.schedule),
          ),
        );
      }
      // A payment count, not money: an integer rendered as its own decimal
      // literal (AR-06). The last payment divides by one and so returns the
      // whole remaining cost — no residue can outlive the schedule.
      return ok(returnCapital(state, state.totalCost.dividedBy(String(remaining))));
    }
    case 'unsupported':
      return err(amortizationNotSupported(date));
  }
}

/**
 * SPEC-007 BR-007-05c: total cost falls by `principal` but never below zero,
 * and whatever exceeds the remaining cost is realized gain (BR-007-09).
 * Quantity is untouched; the average is recomputed by `makePosition`, which
 * also leaves a flat position flat (BR-007-07) with the gain kept.
 *
 * Worked example — 10 shares costing 50,00 receive 60,00: 50,00 is returned
 * capital, total cost 0, average 0, and 60,00 − 50,00 = 10,00 is realized.
 */
function returnCapital(state: PositionState, principal: Money): PositionState {
  const excess =
    principal.comparedTo(state.totalCost) > 0 ? principal.minus(state.totalCost) : Money.zero();
  return makePosition(
    state.quantity,
    state.totalCost.minus(principal.minus(excess)),
    state.realizedGain.plus(excess),
  );
}
