import type { AssetId } from '@/core/shared/ids';
import { Money, Quantity, sumMoney } from '@/core/shared/money';
import { isQuoteStale } from '@/core/quotes/staleness';
import { TARGET_TOTAL_PCT, type WalletTarget } from '@/core/wallets/targets';

/**
 * SPEC-017 — the distance between what the user said they intended and what
 * they hold, in percentage points.
 *
 * BR-017-14: `drift = current − target`, signed. Nothing here decides what to
 * do about it; `rebalance-gap.ts` turns the same difference into R$ and an
 * approximate share count, and neither file names a trade (BR-017-19).
 */

/** One targeted asset's contribution: its slice of the wallet, priced. */
export interface TargetedValue {
  readonly assetId: AssetId;
  /** BR-017-13: the market value of **this wallet's** allocated quantity (SPEC-011 BR-011-11). */
  readonly value: Money;
  /** BR-017-21: whether the price behind `value` may be used at all. */
  readonly priceUsable: boolean;
}

export interface DriftRow {
  readonly assetId: AssetId;
  readonly targetPct: Quantity;
  readonly value: Money;
  /** BR-017-13: share of the wallet's **targeted** market value. `null` when unavailable. */
  readonly currentPct: Quantity | null;
  /** BR-017-14: `current − target`, in percentage points, signed. `null` when unavailable. */
  readonly driftPp: Quantity | null;
  /** BR-017-15: `|drift|` **exceeds** the tolerance. Never true while drift is unavailable. */
  readonly outOfTolerance: boolean;
  readonly priceUsable: boolean;
}

/**
 * BR-017-21 — why drift can be unavailable, and it is never "stale".
 *
 * `PRICE_UNUSABLE` is the rule as written: at least one targeted asset carries
 * a price that is stale or was never obtained, so no share computed against it
 * would be a fact about today.
 *
 * `NO_TARGETED_VALUE` is the same refusal the Composition report makes in
 * `sharesOf` (BR-015-10): a share of a zero total is undefined, not zero, and
 * rendering 0,00 % gives the reader a figure they cannot tell from a real one.
 */
export const DriftUnavailableReason = {
  PRICE_UNUSABLE: 'PRICE_UNUSABLE',
  NO_TARGETED_VALUE: 'NO_TARGETED_VALUE',
} as const;
export type DriftUnavailableReason =
  (typeof DriftUnavailableReason)[keyof typeof DriftUnavailableReason];

export interface DriftReport {
  readonly rows: readonly DriftRow[];
  /** BR-017-13's denominator — the targeted market value. */
  readonly targetedValue: Money;
  /** BR-017-16: at least one targeted asset is out of tolerance. */
  readonly outOfBalance: boolean;
  /** `null` when every figure was computed. */
  readonly unavailableReason: DriftUnavailableReason | null;
  /** The assets whose price could not be used — named, so the view can say which. */
  readonly unpricedAssetIds: readonly AssetId[];
}

/**
 * BR-017-21 — is this asset's price usable for drift *right now*?
 *
 * Three inputs, and the middle one is the subtle case. SPEC-009 never leaves a
 * holding unvalued: an asset nothing could price falls back to cost and is
 * marked `PRICE_UNAVAILABLE` (DL-009-05), which is a defensible figure for a
 * portfolio total and a meaningless one for a *share* — cost against a
 * denominator of market values is not a proportion of anything.
 *
 * Staleness reuses SPEC-008's own rule (`isQuoteStale`) rather than a second
 * definition, including its most important half: **outside the session a
 * stored quote is never stale, however old.** A Saturday reading of a Friday
 * close is not a degraded answer, it is the answer — which is also why a
 * carried-forward close (SPEC-009 BR-009-03) does not disqualify an asset
 * here. The absent-quote case follows the same logic in reverse: with the
 * session open and no intraday quote at all, whatever priced this holding is
 * at least a day old, which is past any cadence.
 */
export interface PriceFreshness {
  /** SPEC-009: nothing could price this holding and it sits at cost. */
  readonly priceUnavailable: boolean;
  /** SPEC-008 `latest_quotes.quoted_at`, or `null` when there is no intraday quote. */
  readonly quotedAt: Date | null;
  readonly sessionOpen: boolean;
  /** The resolved `quotes.cadence_minutes` (SPEC-002), including a runtime degradation. */
  readonly cadenceMinutes: number;
  readonly now: Date;
}

export function isPriceUsable(freshness: PriceFreshness): boolean {
  if (freshness.priceUnavailable) return false;
  if (freshness.quotedAt === null) return !freshness.sessionOpen;
  return !isQuoteStale(
    freshness.sessionOpen,
    freshness.cadenceMinutes,
    freshness.now,
    freshness.quotedAt,
  );
}

/**
 * BR-017-13/14/15/16 — the drift table for one wallet.
 *
 * ---------------------------------------------------------------------------
 * ONE UNUSABLE PRICE MAKES THE WHOLE TABLE UNAVAILABLE, AND THAT IS DELIBERATE.
 *
 * BR-017-21 says an asset whose quote is stale reads unavailable. Read
 * literally that is one row — but every row's `currentPct` is a share of the
 * **same denominator**, and the denominator includes the unpriced asset. Drop
 * it from the sum and every remaining share is inflated by exactly the weight
 * of the thing that could not be measured; keep it at its cost fallback and
 * the denominator mixes cost with market value. Both produce a full table of
 * confident, wrong percentages with nothing on screen to say so, which is the
 * failure mode BR-017-21 exists to prevent — applied to the numerator only.
 *
 * So the refusal propagates to the denominator, the view names the assets
 * responsible, and `unpricedAssetIds` is what it names them from. This is the
 * same choice `core/reporting/snapshot-derived.ts` makes for a chart it cannot
 * honestly draw, and the same one SPEC-012 made in refusing TWR at wallet
 * scope: a stated absence beats a plausible number.
 * ---------------------------------------------------------------------------
 *
 * `targets` and `values` must cover the same assets — `balance.ts` derives
 * both from one partition of the wallet, so a mismatch is a programming error
 * rather than a user-reachable state. A value with no target is ignored; a
 * target with no value is treated as worth nothing, which is what an asset
 * allocated at zero quantity actually is.
 */
export function computeDrift(
  targets: readonly WalletTarget[],
  values: readonly TargetedValue[],
  tolerancePp: Quantity,
): DriftReport {
  const byAsset = new Map(values.map((entry) => [entry.assetId, entry]));
  const targetedValue = sumMoney(
    targets.map((target) => byAsset.get(target.assetId)?.value ?? Money.zero()),
  );

  const unpricedAssetIds = targets
    .filter((target) => byAsset.get(target.assetId)?.priceUsable === false)
    .map((target) => target.assetId);

  const unavailableReason: DriftUnavailableReason | null =
    unpricedAssetIds.length > 0
      ? DriftUnavailableReason.PRICE_UNUSABLE
      : targetedValue.isZero() && targets.length > 0
        ? DriftUnavailableReason.NO_TARGETED_VALUE
        : null;

  if (unavailableReason !== null) {
    return {
      rows: targets.map((target) => ({
        assetId: target.assetId,
        targetPct: target.targetPct,
        value: byAsset.get(target.assetId)?.value ?? Money.zero(),
        currentPct: null,
        driftPp: null,
        outOfTolerance: false,
        priceUsable: byAsset.get(target.assetId)?.priceUsable ?? true,
      })),
      targetedValue,
      // BR-017-16 is about a *computed* excess. A wallet nobody could measure
      // is not out of balance; it is unmeasured, and flagging it would send
      // the user to a screen that cannot tell them anything.
      outOfBalance: false,
      unavailableReason,
      unpricedAssetIds,
    };
  }

  const currentShares = sharesOfTargetedValue(targets, byAsset, targetedValue);

  const rows: DriftRow[] = targets.map((target, index) => {
    const currentPct = currentShares[index] as Quantity;
    const driftPp = currentPct.minus(target.targetPct);
    return {
      assetId: target.assetId,
      targetPct: target.targetPct,
      value: byAsset.get(target.assetId)?.value ?? Money.zero(),
      currentPct,
      driftPp,
      // BR-017-15 says **exceeds**, so a drift landing exactly on the
      // tolerance is inside it. The boundary is stated in the rule and is the
      // one place an off-by-one here would change which assets a user sees
      // flagged.
      outOfTolerance: absolute(driftPp).comparedTo(tolerancePp) > 0,
      priceUsable: true,
    };
  });

  return {
    rows,
    targetedValue,
    outOfBalance: rows.some((row) => row.outOfTolerance),
    unavailableReason: null,
    unpricedAssetIds: [],
  };
}

/**
 * Each targeted asset's share of the targeted value, summing to **exactly**
 * 100 — the last row takes the residual, as `equalWeightTargets` and
 * `distributeExact` do.
 *
 * Worth the trouble for a reason specific to this file: targets total exactly
 * 100 (BR-017-04) and current shares total exactly 100, so every drift figure
 * on screen sums to exactly zero. Divide all n and the shares total 99,999…,
 * which would leave a wallet with a permanent phantom drift of −1e-38 spread
 * across it — invisible in the UI and fatal to the invariant that makes the
 * table readable.
 */
function sharesOfTargetedValue(
  targets: readonly WalletTarget[],
  byAsset: ReadonlyMap<AssetId, TargetedValue>,
  targetedValue: Money,
): readonly Quantity[] {
  const shares: Quantity[] = [];
  let allocated = Quantity.zero();
  for (let index = 0; index < targets.length - 1; index += 1) {
    const value = byAsset.get((targets[index] as WalletTarget).assetId)?.value ?? Money.zero();
    const share = Quantity.fromString(value.toString())
      .dividedBy(Quantity.fromString(targetedValue.toString()))
      .times(TARGET_TOTAL_PCT);
    shares.push(share);
    allocated = allocated.plus(share);
  }
  if (targets.length > 0) shares.push(TARGET_TOTAL_PCT.minus(allocated));
  return shares;
}

/** `Quantity` has no `abs`, and a drift's magnitude is what the tolerance compares. */
function absolute(value: Quantity): Quantity {
  return value.isNegative() ? value.negated() : value;
}
