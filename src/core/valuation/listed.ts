import { BusinessDate, businessDateInSaoPaulo } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { Money, type Quantity } from '@/core/shared/money';
import {
  NeedsAttentionReason,
  ValuationMethod,
  type AssetClass,
  type LatestQuote,
  type PriceQuote,
  type ValuedPosition,
} from '@/core/valuation/ports';

/**
 * SPEC-009 BR-009-01..04 — stocks, FIIs, BDRs and ETFs.
 *
 * **Why `mode` exists.** BR-009-02 forbids a historical valuation from ever
 * touching an intraday quote, and the reason is not purity: if a past chart
 * point could move depending on what time of day the page was loaded, the same
 * historical fact would render differently on two screens. That destroys
 * confidence in every other number on the page, including the ones that are
 * right. So the two modes read from two different places, and this function is
 * the only thing that decides which — `PriceHistoryPort` keeps the two tables
 * apart (SPEC-008 BR-008-10), and nothing here can reach across.
 *
 * **BR-009-20 / AC-17: no FX layer.** BDRs trade in BRL on B3, so a BDR is
 * valued exactly like any other listed asset. The consequence — a BDR's BRL
 * return blends the underlying's move with USD/BRL — is disclosed by the
 * product (DL-009-07), not corrected for here.
 */

export type ListedValuationMode = 'historical' | 'current';

export interface ListedPriceLookup {
  /**
   * BR-009-03: the last official close **on or before** the valuation date,
   * carrying its own date so a stale price can be labelled rather than
   * silently passed off as today's.
   */
  readonly close: PriceQuote | null;
  /** BR-009-01: the delayed intraday quote. Read in `current` mode only. */
  readonly latest: LatestQuote | null;
}

export interface ListedValuationInputs {
  readonly assetId: AssetId;
  readonly assetClass: AssetClass;
  readonly quantity: Quantity;
  /** SPEC-007's *preço médio*, for BR-009-04's unrealised gain. */
  readonly averageCost: Money;
  readonly asOf: BusinessDate;
  readonly mode: ListedValuationMode;
  readonly prices: ListedPriceLookup;
}

interface ResolvedPrice {
  readonly unitPrice: Money;
  readonly priceDate: BusinessDate;
  readonly carriedForward: boolean;
}

/**
 * BR-009-01/02/03 — which price, and whether it was carried forward.
 *
 * `current` mode prefers the intraday quote and falls back to the last close,
 * because "no quote yet today" is the normal state before the first poll of
 * the session, not an error. `historical` mode never even looks.
 */
function resolvePrice(inputs: ListedValuationInputs): ResolvedPrice | null {
  const { close, latest } = inputs.prices;

  if (inputs.mode === 'current' && latest !== null) {
    // AR-29: the quote's instant is resolved to a São Paulo business date, not
    // a UTC one — a quote taken at 21:30 UTC is the *next* day in UTC and
    // would otherwise be reported as tomorrow's price.
    const priceDate = businessDateInSaoPaulo(latest.quotedAt);
    return {
      unitPrice: latest.price,
      priceDate,
      carriedForward: BusinessDate.isBefore(priceDate, inputs.asOf),
    };
  }

  if (close === null) return null;
  return {
    unitPrice: close.close,
    priceDate: close.date,
    // BR-009-03 / AC-3: a holiday, a suspension or a pre-listing gap. The
    // value is still the best available, but the UI must be able to say the
    // price is older than the date it is shown against — silent carry-forward
    // is how a delisted asset quietly holds a stale value for months.
    carriedForward: BusinessDate.isBefore(close.date, inputs.asOf),
  };
}

/**
 * BR-009-01/04 — `value = quantity × price`, `unrealised = value − quantity ×
 * average cost`.
 *
 * Worked example (DV-17): 100 PETR4 bought at an average of R$ 32,15, closing
 * at R$ 38,42 —
 *   value      = 100 × 38,42 = 3.842,00
 *   cost basis = 100 × 32,15 = 3.215,00
 *   unrealised = 3.842,00 − 3.215,00 = **627,00**
 *
 * With no price at all — never listed, or a catalog entry with no history —
 * the position is valued at its cost basis and flagged, never dropped from the
 * total. That extends DL-009-05's reasoning beyond fixed income deliberately:
 * omitting understates the portfolio with no visible cause, which is the one
 * failure mode a user cannot detect.
 */
export function valueListed(inputs: ListedValuationInputs): ValuedPosition {
  const costBasis = inputs.averageCost.times(inputs.quantity);
  const resolved = resolvePrice(inputs);

  if (resolved === null) {
    return {
      assetId: inputs.assetId,
      assetClass: inputs.assetClass,
      quantity: inputs.quantity,
      value: costBasis,
      costBasis,
      // Valued *at* cost, so by construction nothing is gained or lost. Stated
      // as a literal zero rather than `value − costBasis` so the reader does
      // not have to prove the subtraction cancels.
      unrealizedGain: Money.zero(),
      method: ValuationMethod.COST_FALLBACK,
      estimated: true,
      grossOfTaxes: false,
      priceDate: null,
      carriedForward: false,
      needsAttention: NeedsAttentionReason.PRICE_UNAVAILABLE,
      basis: null,
    };
  }

  const value = resolved.unitPrice.times(inputs.quantity);
  return {
    assetId: inputs.assetId,
    assetClass: inputs.assetClass,
    quantity: inputs.quantity,
    value,
    costBasis,
    unrealizedGain: value.minus(costBasis),
    method: ValuationMethod.LISTED_QUOTE,
    // An observed market price, whatever its date. A carried-forward close is
    // reported by `carriedForward`, not by pretending the figure was computed.
    estimated: false,
    // BR-009-12 concerns fixed income; an equity value has no tax withheld
    // from it in the first place.
    grossOfTaxes: false,
    priceDate: resolved.priceDate,
    carriedForward: resolved.carriedForward,
    needsAttention: null,
    basis: null,
  };
}
