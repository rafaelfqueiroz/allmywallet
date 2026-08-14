import { BusinessDate } from '@/core/shared/clock';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { err, ok, type Result } from '@/core/shared/result';
import { earliestOf, listBusinessDays } from '@/core/valuation/business-days';
import {
  NeedsAttentionReason,
  ValuationErrorCode,
  ValuationMethod,
  type AssetClass,
  type EstimateBasis,
  type FixedIncomeContract,
  type IndexSeriesPoint,
  type TradingCalendar,
  type ValuedPosition,
} from '@/core/valuation/ports';

/**
 * SPEC-009 BR-009-07..15 — CDB, LCI and LCA.
 *
 * **Why accrual exists at all** (DL-009-01): there is no public daily price
 * for bank paper. Holding it at cost would make a large slice of many
 * portfolios appear flat for years, which is a confidently wrong picture;
 * accruing from the contracted indexer is an estimate, but a well-founded one,
 * and BR-009-11 requires it to be *labelled* rather than blended invisibly
 * with observed prices.
 *
 * **What is accrued.** A `factor`, not a value. The factor is a pure function
 * of the contract's terms, the published index series and the trading
 * calendar; the money it multiplies is the position's own cost basis from the
 * ledger (SPEC-007), never the contract's `principal` field. That choice is
 * deliberate: a contract row and the ledger can disagree — a partial
 * redemption, a correction, a re-import — and when they do, the ledger wins
 * (BR-006-01). Anchoring on cost basis also makes the arithmetic correct for
 * any quantity rather than only for a single whole contract.
 *
 * **Gross of IR and IOF** (BR-009-12, DL-009-03). Nothing here deducts tax.
 * A wrong net figure is worse than an explicitly gross one, because users
 * would trust it and be wrong at redemption. The UI states it; this file
 * simply never pretends otherwise.
 */

const ONE = Quantity.fromString('1');
const HUNDRED = Quantity.fromString('100');
/** DL-009-08: the Brazilian year, in business days. */
const BUSINESS_DAYS_PER_YEAR = Quantity.fromString('252');

/**
 * The one place `Decimal` is touched directly in this directory, and the
 * reason is a real gap rather than convenience: a 252-day compounding factor
 * needs `(1 + i)^(du/252)`, a fractional exponent, and `Money`/`Quantity`
 * deliberately expose no `pow` (AR-08 — they are money types, and money is
 * never raised to a power). A *rate* legitimately is.
 *
 * The value crosses back through a plain decimal string, so nothing here can
 * introduce a JS `number` into a money path (AR-06). `decimal.js` is
 * configured once, in `core/shared/money.ts`: 40 significant digits,
 * truncating — so this inherits the same determinism as every other figure.
 */
function powFactor(base: Quantity, exponent: Quantity): Quantity {
  return Quantity.fromString(base.toDecimal().pow(exponent.toDecimal()).toFixed());
}

/** `12.5` → `0.125`. Done once, here, so no call site has to remember. */
function percentToFraction(percent: Quantity): Quantity {
  return percent.dividedBy(HUNDRED);
}

export interface AccrualInputs {
  readonly contract: FixedIncomeContract | null;
  /** The valuation date. */
  readonly asOf: BusinessDate;
  readonly calendar: TradingCalendar;
  /** BCB SGS series 12 — **daily** CDI, in percent per day. */
  readonly cdi: readonly IndexSeriesPoint[];
  /** BCB SGS series 433 — **monthly** IPCA, in percent per month, dated the 1st. */
  readonly ipca: readonly IndexSeriesPoint[];
}

export interface AccrualOutcome {
  /** Multiply the cost basis by this. `1` means nothing has accrued yet. */
  readonly factor: Quantity;
  readonly basis: EstimateBasis;
}

/**
 * BR-009-08 — **% of CDI.**
 *
 * `factor = Π over business days [ 1 + (CDI_d / 100) × (p / 100) ]`
 *
 * where `CDI_d` is SGS series 12's published value for that day (already a
 * *daily* rate in percent) and `p` is the contracted percentage. This is the
 * CETIP convention: the percentage scales the daily rate, and the scaled rates
 * compound — it is **not** `(Π (1 + CDI_d/100))^p`, which would compound the
 * percentage as well and overstate a 110% CDB.
 *
 * Worked example (DV-17) — R$ 10.000,00 at 110% of CDI, issued Monday
 * 2026-03-16 and valued Friday 2026-03-20, so four business days accrue
 * (16, 17, 18, 19 — the 20th is excluded by the convention):
 *
 *   p = 110 / 100 = 1,1
 *   16/03 and 17/03 at CDI 0,05078803 %/day → 1 + 0,0005078803 × 1,1 = 1,00055866833
 *   18/03 and 19/03 at CDI 0,04903749 %/day → 1 + 0,0004903749 × 1,1 = 1,00053941239
 *
 *   factor = 1,00055866833² × 1,00053941239²
 *          = 1,002197970588415656252996632310492899145
 *   value  = 10.000 × factor = **10.021,97970588** (to the 8 places NUMERIC(20,8) stores)
 */
function cdiFactor(
  contractPercent: Quantity,
  days: readonly BusinessDate[],
  points: readonly IndexSeriesPoint[],
): { factor: Quantity; missingIndexDays: number } {
  const byDate = new Map<string, Quantity>(points.map((point) => [point.date, point.value]));
  const scale = percentToFraction(contractPercent);

  let factor = ONE;
  let missingIndexDays = 0;
  for (const day of days) {
    const published = byDate.get(day);
    if (published === undefined) {
      // Never zero, never a guessed rate. The day simply does not compound,
      // and the count travels with the result so the gap is visible — the
      // accrual analogue of BR-009-03's carry-forward marker. A missing point
      // is normally BCB's own publication lag (today's CDI lands tomorrow),
      // which no user action can fix, so it is *not* a "Needs attention" item.
      missingIndexDays += 1;
      continue;
    }
    factor = factor.times(ONE.plus(percentToFraction(published).times(scale)));
  }
  return { factor, missingIndexDays };
}

/**
 * BR-009-09 — **prefixado**, on the 252-day basis.
 *
 *   `factor = (1 + r/100) ^ (DU / 252)`
 *
 * Worked example (DV-17) — R$ 5.000,00 at 12% a.a., issued 2026-03-16 and
 * valued 2026-04-30. `DU` = 31 business days (see `business-days.ts` for the
 * hand count, which excludes Sexta-feira Santa and Tiradentes):
 *
 *   factor = 1,12 ^ (31/252) = 1,12 ^ 0,123015873…
 *          = 1,014038859244252849711902671951704402468
 *   value  = 5.000 × factor = **5.070,19429622**
 *
 * Note what is *not* done: no 365-calendar-day pro-rata. That convention would
 * compute 1,12 ^ (45/365) = 1,0140700946… → R$ 5.070,35, sixteen centavos
 * higher. DL-009-08's reason is not the size of that gap — it is that 252
 * business days is what the issuer itself computes, so it is the only
 * convention under which a user reconciling against a bank statement gets an
 * exact match rather than a near one.
 */
function annualRateFactor(annualPercent: Quantity, businessDays: number): Quantity {
  const base = ONE.plus(percentToFraction(annualPercent));
  const exponent = Quantity.fromString(String(businessDays)).dividedBy(BUSINESS_DAYS_PER_YEAR);
  return powFactor(base, exponent);
}

/**
 * BR-009-10 — **IPCA + spread.**
 *
 * `factor = Π (1 + IPCA_m/100) × (1 + spread/100)^(DU/252)`
 *
 * The monthly index applies to principal; the spread accrues on business days
 * exactly as a prefixado does. A published IPCA point is dated the **first of
 * the month it measures**, so a point counts when it falls inside
 * `[issueDate, throughDate]`.
 *
 * Two things the spec does not settle, decided here and flagged in the
 * dispatch report rather than buried:
 *
 *  1. **No intra-month pro-rata.** The real NTN-B convention interpolates
 *     IPCA daily between 15th-of-month anniversaries. BR-009-10 says
 *     "monthly IPCA applied to principal" and v1 does exactly that; the
 *     figure is labelled an estimate either way (BR-009-11).
 *  2. **A month is applied whole or not at all**, on its publication date.
 *
 * Worked example (DV-17) — R$ 20.000,00 at IPCA + 6% a.a., issued 2026-01-15,
 * valued 2026-04-15, with IPCA 0,42% (Jan), 0,83% (Feb) and 0,16% (Mar):
 *
 *   IPCA factor  = 1,0042 × 1,0083 × 1,0016 = 1,014154915776
 *   DU           = 61 business days
 *   spread       = 1,06 ^ (61/252) = 1,014204717055610400986196218283678182234
 *   factor       = 1,028560699405…
 *   value        = 20.000 × factor = **20.571,21398810**
 */
function ipcaFactor(points: readonly IndexSeriesPoint[]): Quantity {
  let factor = ONE;
  for (const point of points) {
    factor = factor.times(ONE.plus(percentToFraction(point.value)));
  }
  return factor;
}

/**
 * The accrual window: `[issueDate, min(asOf, maturityDate))`.
 *
 * BR-009-15 lives in the `min`. A matured instrument stops accruing at
 * maturity and holds its maturity value until a redemption transaction is
 * recorded — so valuing it a year later returns the same number, not a year
 * of phantom interest.
 */
function accrualWindow(
  contract: FixedIncomeContract,
  asOf: BusinessDate,
): { throughDate: BusinessDate; matured: boolean } {
  if (contract.maturityDate === null) return { throughDate: asOf, matured: false };
  return {
    throughDate: earliestOf(asOf, contract.maturityDate),
    // Equality counts as matured: an instrument valued *on* its maturity date
    // has reached maturity, and accrues nothing further from that day on.
    matured: !BusinessDate.isBefore(asOf, contract.maturityDate),
  };
}

/**
 * BR-009-07..15 — the accrual factor for one fixed-income contract, or the
 * reason it could not be computed.
 *
 * BR-009-13 / AC-11: "could not be computed" is an `err`, never a zero. The
 * caller (`valueFixedIncome`) turns it into a position valued **at cost** and
 * flagged for the "Needs attention" queue — omitting it would understate the
 * portfolio silently, with no visible cause (DL-009-05).
 */
export function accrualFactor(inputs: AccrualInputs): Result<AccrualOutcome, DomainError> {
  const { contract, asOf, calendar } = inputs;
  if (contract === null) {
    return err(domainError(ValuationErrorCode.CONTRACT_MISSING, {}));
  }
  const { indexer, ratePercent } = contract;
  if (indexer === null || ratePercent === null) {
    return err(
      domainError(ValuationErrorCode.RATE_UNREADABLE, {
        // AR-39: primitives only, and nothing here identifies a person.
        indexer: indexer ?? null,
        hasRate: ratePercent !== null,
      }),
    );
  }

  const { throughDate, matured } = accrualWindow(contract, asOf);
  const days = listBusinessDays(calendar, contract.issueDate, throughDate);

  let factor: Quantity;
  let missingIndexDays = 0;
  if (indexer === 'cdi_percent') {
    const computed = cdiFactor(ratePercent, days, inputs.cdi);
    factor = computed.factor;
    missingIndexDays = computed.missingIndexDays;
  } else if (indexer === 'prefixado') {
    factor = annualRateFactor(ratePercent, days.length);
  } else {
    // 'ipca_spread' — the union has exactly three members, so this arm is the
    // third rather than a default that could silently absorb a fourth.
    const applicable = inputs.ipca.filter(
      (point) => point.date >= contract.issueDate && point.date <= throughDate,
    );
    factor = ipcaFactor(applicable).times(annualRateFactor(ratePercent, days.length));
  }

  return ok({
    factor,
    basis: {
      indexer,
      ratePercent: ratePercent.toString(),
      businessDays: days.length,
      throughDate,
      matured,
      missingIndexDays,
    },
  });
}

export interface FixedIncomeValuationInputs extends AccrualInputs {
  readonly assetId: AssetId;
  readonly assetClass: AssetClass;
  readonly quantity: Quantity;
  /** SPEC-007's *preço médio* for this position. */
  readonly averageCost: Money;
}

/**
 * BR-009-07/11/12/13/15 — one CDB, LCI or LCA position, valued.
 *
 * Always returns a position. There is no path here that returns zero, omits
 * the holding, or throws: an unreadable contract yields the cost basis,
 * flagged and queued (DL-009-05), which is a defensible floor a user can see
 * and act on.
 */
export function valueFixedIncome(inputs: FixedIncomeValuationInputs): ValuedPosition {
  const costBasis = inputs.averageCost.times(inputs.quantity);
  const accrued = accrualFactor(inputs);

  if (!accrued.ok) {
    return {
      assetId: inputs.assetId,
      assetClass: inputs.assetClass,
      quantity: inputs.quantity,
      value: costBasis,
      costBasis,
      unrealizedGain: Money.zero(),
      method: ValuationMethod.COST_FALLBACK,
      // Still an estimate: it is a stand-in for a value nobody has computed,
      // which is precisely what the marker exists to say.
      estimated: true,
      grossOfTaxes: true,
      priceDate: null,
      carriedForward: false,
      needsAttention:
        accrued.error.code === ValuationErrorCode.CONTRACT_MISSING
          ? NeedsAttentionReason.FIXED_INCOME_CONTRACT_MISSING
          : NeedsAttentionReason.FIXED_INCOME_RATE_UNREADABLE,
      basis: null,
    };
  }

  const value = costBasis.times(accrued.value.factor);
  return {
    assetId: inputs.assetId,
    assetClass: inputs.assetClass,
    quantity: inputs.quantity,
    value,
    costBasis,
    // BR-009-04, applied to fixed income: the accrued interest *is* the
    // unrealised gain, since the cost basis is what was invested.
    unrealizedGain: value.minus(costBasis),
    method: ValuationMethod.FIXED_INCOME_ACCRUAL,
    // BR-009-11 / DL-009-02: always. An accrued figure approximates carrying
    // value; it is not what a secondary-market sale would fetch.
    estimated: true,
    grossOfTaxes: true,
    priceDate: accrued.value.basis.throughDate,
    carriedForward: false,
    needsAttention: null,
    basis: accrued.value.basis,
  };
}
