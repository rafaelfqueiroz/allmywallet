import { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { Money, type Quantity } from '@/core/shared/money';
import {
  NeedsAttentionReason,
  ValuationMethod,
  type PriceQuote,
  type ValuedPosition,
} from '@/core/valuation/ports';

/**
 * SPEC-009 BR-009-05/06, DL-009-04 — Tesouro Direto.
 *
 * **Observed, not estimated** (BR-009-05 / AC-5). Tesouro Transparente
 * publishes a real daily price for every title, so a Tesouro position is
 * marked to market exactly like a listed asset and carries **no** estimate
 * marker. Only bank paper is accrued (`accrual.ts`), and only bank paper is
 * labelled an estimate. Blending the two would misrepresent precision in both
 * directions.
 *
 * **The sell price, not the buy price** (BR-009-06 / DL-009-04). Where a title
 * has both, the sell price — `PU Venda Manhã` in the published file — is what
 * the holder would actually realise. Using the buy price would systematically
 * overstate every Tesouro holding by the spread, silently and in the same
 * direction every day.
 *
 * That rule is enforced at **ingestion**, in
 * `src/adapters/quotes/tesouro.ts`, which is what writes `price_quotes`; this
 * module consumes whatever that adapter stored. The two halves are recorded
 * together here on purpose, because a future change to the CSV column would
 * otherwise break BR-009-06 in a file that never mentions it.
 *
 * **BR-009-12 / AC-10: gross of IR and IOF.** Tesouro Direto is fixed income
 * and its returns are taxed at redemption; v1 shows the gross figure and says
 * so, because a wrong net figure would be trusted.
 */

export interface TesouroValuationInputs {
  readonly assetId: AssetId;
  readonly quantity: Quantity;
  /** SPEC-007's *preço médio*, for BR-009-04's unrealised gain. */
  readonly averageCost: Money;
  readonly asOf: BusinessDate;
  /**
   * The published sell price on or before `asOf`. Carries its own date so
   * BR-009-03's carry-forward can be shown rather than assumed — Tesouro
   * publishes on business days only, so every weekend is a carry-forward.
   */
  readonly sellPrice: PriceQuote | null;
}

export function valueTesouro(inputs: TesouroValuationInputs): ValuedPosition {
  const costBasis = inputs.averageCost.times(inputs.quantity);

  if (inputs.sellPrice === null) {
    // DL-009-05's floor, applied to a title with no published price at all
    // (a brand-new issue, or a catalog entry `tesouro.sync` has not reached).
    // Never zero, never omitted.
    return {
      assetId: inputs.assetId,
      assetClass: 'tesouro_direto',
      quantity: inputs.quantity,
      value: costBasis,
      costBasis,
      unrealizedGain: Money.zero(),
      method: ValuationMethod.COST_FALLBACK,
      estimated: true,
      grossOfTaxes: true,
      priceDate: null,
      carriedForward: false,
      needsAttention: NeedsAttentionReason.PRICE_UNAVAILABLE,
      basis: null,
    };
  }

  /**
   * Worked example (DV-17): 3,5 units of Tesouro IPCA+ 2035 bought at an
   * average PU of R$ 3.200,00, with the day's `PU Venda Manhã` at
   * R$ 3.413,70 —
   *   value      = 3,5 × 3.413,70 = 11.947,95
   *   cost basis = 3,5 × 3.200,00 = 11.200,00
   *   unrealised = **747,95**
   * Had the buy price (R$ 3.415,00) been used instead, the same position would
   * read 11.952,50 — R$ 4,55 the holder could not actually get.
   */
  const value = inputs.sellPrice.close.times(inputs.quantity);
  return {
    assetId: inputs.assetId,
    assetClass: 'tesouro_direto',
    quantity: inputs.quantity,
    value,
    costBasis,
    unrealizedGain: value.minus(costBasis),
    method: ValuationMethod.TESOURO_SELL_PRICE,
    // BR-009-05 / AC-5: an observed price. Not flagged as an estimate.
    estimated: false,
    grossOfTaxes: true,
    priceDate: inputs.sellPrice.date,
    carriedForward: BusinessDate.isBefore(inputs.sellPrice.date, inputs.asOf),
    needsAttention: null,
    basis: null,
  };
}
