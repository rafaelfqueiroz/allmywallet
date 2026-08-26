import Decimal from 'decimal.js';
import type { AssetId } from '@/core/shared/ids';
import { Quantity, type Money } from '@/core/shared/money';
import { TARGET_TOTAL_PCT } from '@/core/wallets/targets';

/**
 * SPEC-017 BR-017-18/19/20 — the gap, as arithmetic.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT ALLOWED TO BE.
 *
 * Everything below is division. The target came from the user (BR-017-04), the
 * price is one the product already displays (SPEC-008), and the quantity is
 * what they hold. Nothing here ranks an asset, picks an order, or names a
 * trade — BR-017-19 and SPEC-015 BR-015-06 forbid it, and DL-017-01 makes that
 * prohibition the ground the whole spec stands on.
 *
 * The naming carries the same weight as the arithmetic. These are distances
 * from the user's own target, so the fields are `gapValue` and `gapShares` —
 * never `buy`, `sell`, `trim` or `rebalance`. A field called `sharesToBuy`
 * would be a recommendation regardless of what the label above it said.
 *
 * DL-017-07 is why both directions are computed. Withholding the overweight
 * side would go silent in exactly the case that matters most — a wallet badly
 * skewed by a winner — while reducing no exposure at all, since a
 * percentage-point gap implies the same action, just less legibly.
 * ---------------------------------------------------------------------------
 */

export interface GapInput {
  readonly assetId: AssetId;
  /** BR-017-04: the percentage the user set, or `100 / n` in equal weight. */
  readonly targetPct: Quantity;
  /** BR-017-13: this asset's share of the targeted value, already computed. */
  readonly currentPct: Quantity;
  /** The market value of this wallet's allocated quantity. */
  readonly value: Money;
  /** This wallet's allocated quantity (SPEC-010 BR-010-04) — the share count's divisor. */
  readonly quantity: Quantity;
  /** BR-017-13's denominator: the wallet's targeted market value. */
  readonly targetedValue: Money;
}

export interface RebalanceGap {
  readonly assetId: AssetId;
  /**
   * `target − current`, in percentage points. Positive means the holding sits
   * **below** the target, negative **above** it — the mirror of `driftPp`
   * (BR-017-14), which is stated the other way round because drift describes
   * where the wallet *is* and the gap describes the distance left.
   */
  readonly gapPp: Quantity;
  /** BR-017-18: the same distance in R$, at the wallet's targeted value. */
  readonly gapValue: Money;
  /**
   * BR-017-18/20: the same distance in shares, at the price already on screen.
   *
   * `null` when the holding has no quantity to derive a unit price from. Always
   * **approximate** when present — the quote carries SPEC-008's delay, so this
   * is exact arithmetic over a price that is already old, and BR-017-20
   * requires it to be labelled as such wherever it is rendered.
   */
  readonly gapShares: Quantity | null;
  /**
   * BR-017-20: `gapShares` at the asset's tradable precision — whole units,
   * truncated **toward zero**.
   *
   * Truncation rather than rounding, and toward zero rather than down, so the
   * figure never overstates the distance in either direction: an overweight
   * asset 4,8 shares past its target reads 4, not 5. Rounding up would put a
   * number on screen that the arithmetic does not support, which on a screen
   * this careful about not recommending anything would be the product adding a
   * share of its own.
   *
   * Every class a target may cover (`TARGETABLE_CLASSES` — stock, FII, BDR,
   * ETF) trades in whole units on B3, including the fractional market, so one
   * precision covers all four. A class that traded in fractions would need its
   * own scale here rather than this constant.
   */
  readonly tradableShares: Quantity | null;
  /** The unit price the share count divides by — `value ÷ quantity`. */
  readonly unitPrice: Money | null;
}

/**
 * BR-017-18 — one asset's gap, over- and under-weight alike.
 *
 * **`gapValue` is computed from money, not from `gapPp`.** The two would agree
 * to forty significant digits, but `currentPct` carries the residual that
 * makes the shares sum to exactly 100 (`drift.ts`), so re-deriving the R$
 * figure from it would hand that residual to whichever row happened to be
 * last. `target − current` in reais is exact and depends on nothing else on
 * the screen.
 */
export function rebalanceGap(input: GapInput): RebalanceGap {
  const targetValue = input.targetedValue.times(input.targetPct).dividedBy(TARGET_TOTAL_PCT);
  const gapValue = targetValue.minus(input.value);

  const unitPrice = input.quantity.isZero() ? null : input.value.dividedBy(input.quantity);
  const gapShares =
    unitPrice === null || unitPrice.isZero()
      ? null
      : Quantity.fromString(gapValue.toString()).dividedBy(
          Quantity.fromString(unitPrice.toString()),
        );

  return {
    assetId: input.assetId,
    gapPp: input.targetPct.minus(input.currentPct),
    gapValue,
    gapShares,
    tradableShares: gapShares === null ? null : toTradablePrecision(gapShares),
    unitPrice,
  };
}

/** Whole units, truncated toward zero — see `RebalanceGap.tradableShares`. */
export function toTradablePrecision(shares: Quantity): Quantity {
  return Quantity.fromString(shares.toDecimal().toFixed(0, Decimal.ROUND_DOWN));
}
