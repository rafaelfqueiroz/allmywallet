import type { BusinessDate } from '@/core/shared/clock';
import { Money, type Quantity, sumMoney } from '@/core/shared/money';
import { computeTotalValue } from '@/core/ledger/transaction';
import type { AssetLiquidationDefinition } from '@/core/ingestion/asset-conversion-definitions';

/**
 * SPEC-005 BR-005-20c (#143 D10) — a fund **liquidated partly in another
 * asset**, resolved from B3's record at commit.
 *
 * B3 never states the liquidation: it records the cash half as a priced
 * `Resgate` on each source and the in-kind half as price-less `Atualização`
 * credits on a receipt code. The definition supplies the two figures B3 leaves
 * blank — each source's Valor de Liquidação and the target's acquisition cost
 * — and this resolver decides, all or nothing, whether the evidence in hand is
 * one complete liquidation:
 *
 * - every source's priced `Resgate` is a **sale** of its stated quantity at
 *   the source's liquidation value, fees 0 (SPEC-007 BR-007-03: the average is
 *   unchanged, and the result is realised against it, DL-007-02);
 * - every target credit is a **subscription** of B3's stated quantity at the
 *   target's unit cost (SPEC-007 BR-007-06: a buy at that price).
 *
 * Pure (AR-01): which rows exist, what state the ledger holds them in, and
 * what each source position held come from `commit-batch.ts`.
 */

/** What a B3 row is to the liquidation. */
export type LiquidationEvidenceRole = 'source_redemption' | 'target_credit';

/**
 * What the ledger makes of the row today:
 *
 * - `open` — this commit may write it: a row of this batch, a stored copy an
 *   import left `unclassified`, or a stored `sell` no one edited;
 * - `applied` — already what the liquidation makes of it (an active sell at
 *   the liquidation value, an active subscription at the unit cost);
 * - `locked` — anything else a person decided (edited or entered by hand).
 *   BR-005-20c: a row a user classified is never touched, so the whole
 *   liquidation waits rather than completing around it.
 */
export type LiquidationEvidenceState = 'open' | 'applied' | 'locked';

export interface LiquidationEvidence {
  readonly id: string;
  readonly role: LiquidationEvidenceRole;
  /** B3's code on the row: a source code, or the target's evidence code. */
  readonly assetCode: string;
  readonly tradeDate: BusinessDate;
  /**
   * The quantity the row moved: a `Resgate`'s own quantity, or what a target
   * credit **added** (B3's statement less the receipt code's balance before
   * that day — `repeatedTargetCredits`' reading, #143).
   */
  readonly quantity: Quantity;
  readonly state: LiquidationEvidenceState;
  /**
   * A source `Resgate` only: the source position replayed immediately before
   * the row's date, or `null` where it does not replay. Carried on the row
   * rather than per source, so it is always measured at the `Resgate` the
   * group actually uses.
   */
  readonly heldBefore?: Quantity | null | undefined;
}

export interface LiquidationWritePlan {
  readonly evidenceId: string;
  readonly type: 'sell' | 'subscription';
  /** The **ledger** code the row is written on — RVBI11, never RVBI15. */
  readonly assetCode: string;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
}

export interface ResolvedLiquidation {
  readonly status: 'resolved';
  readonly definitionId: string;
  /** The date of the target credits, which anchors the group. */
  readonly anchorDate: BusinessDate;
  /** Only the `open` rows: an `applied` one is already what it would become. */
  readonly writes: readonly LiquidationWritePlan[];
  /** Σ quantity × liquidation value over every source — the sales' proceeds. */
  readonly proceeds: Money;
  /** Σ quantity × unit cost over every target credit. */
  readonly acquisitionCost: Money;
}

/** Every row of a complete liquidation is already in the ledger as it would write it. */
export interface AppliedLiquidation {
  readonly status: 'applied';
  readonly definitionId: string;
  readonly anchorDate: BusinessDate;
}

export type LiquidationUnresolvedReason =
  /** A source has no priced `Resgate`, or the target no credit (BR-005-17: never on a partial extract). */
  | 'incomplete'
  /** Two `Resgate`s for one source, or target credits on more than one date. */
  | 'ambiguous'
  /** A source's `Resgate` lies outside the configured window of the credits. */
  | 'outside_window'
  /** The `Resgate` does not redeem exactly the position held before it: history is missing or wrong. */
  | 'quantity_mismatch'
  /** A row of the group was edited or entered by hand and is not what the liquidation writes. */
  | 'user_modified';

export interface UnresolvedLiquidation {
  readonly status: 'unresolved';
  readonly reason: LiquidationUnresolvedReason;
}

export type LiquidationResolution = ResolvedLiquidation | AppliedLiquidation | UnresolvedLiquidation;

export interface ResolveLiquidationInput {
  readonly definition: AssetLiquidationDefinition;
  /** Every row of this definition's codes at one institution, from the batch and the ledger. */
  readonly evidence: readonly LiquidationEvidence[];
  /** `import.asset_conversion_window_days` (SPEC-002): no default here. */
  readonly windowDays: number;
}

const unresolved = (reason: LiquidationUnresolvedReason): UnresolvedLiquidation => ({
  status: 'unresolved',
  reason,
});

function dayNumber(date: BusinessDate): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

/**
 * The deterministic identity of one liquidation at one institution, shared by
 * the rows this commit writes and the rows an earlier commit wrote, so a
 * fraction's origin (BR-005-20b) groups them the same way either way.
 */
export function liquidationGroupKey(
  definitionId: string,
  institutionId: string | null,
  anchorDate: BusinessDate,
): string {
  return `liquidation:${definitionId}:${institutionId ?? 'none'}:${anchorDate}`;
}

/**
 * SPEC-005 BR-005-20c (#143 D10) — plans one complete liquidation, or says why
 * there is none. Never partial: a group missing any source's `Resgate` or the
 * target's credits writes nothing, whichever file the missing row is in.
 *
 * Worked example (DV-17), generated figures: 90 BPFF11 held at 9.000,00 and 70
 * HGFF11 at 7.265,32; B3 credits RVBI15 83,89 and 75,36 on 2025-10-06 and
 * redeems 90 and 70 on 2025-10-14.
 *
 * - BPFF11: sale 90 × 62,03538245 = **5.583,1844205**, realising
 *   5.583,1844205 − 9.000,00 = **−3.416,8155795**.
 * - HGFF11: sale 70 × 71,04670108 = **4.973,2690756**, realising
 *   4.973,2690756 − 7.265,32 = **−2.292,0509244**.
 * - RVBI11: subscriptions 83,89 × 64,15 = 5.381,5435 and 75,36 × 64,15 =
 *   4.834,344 — **10.215,8875** for 159,25, average 64,15.
 *
 * Net external flow 10.215,8875 − 10.556,4534961 = **−340,5659961** against
 * the 340,32 of cash B3 states (201,51 + 138,81): a gap of **0,2459961**. It
 * is the administrator's sub-cent figures, which B3 does not carry: receipts
 * credited truncated to two places (90 × 0,93213961 = 83,8925649 → 83,89;
 * 70 × 1,07659877 = 75,3619139 → 75,36) and cash stated at three places per
 * share (2,239 for 2,23862655; 1,983 for 1,98289016). Accepted (#143 D10):
 * the published values are the holder's tax figures, B3's rounded ones are
 * not, and the flow follows the sale and the acquisition it records.
 */
export function resolveLiquidation(input: ResolveLiquidationInput): LiquidationResolution {
  const { definition } = input;
  const targetCode = definition.target.evidenceAssetCode ?? definition.target.assetCode;
  const credits = input.evidence.filter(
    (item) => item.role === 'target_credit' && item.assetCode === targetCode,
  );
  const [firstCredit] = credits;
  if (firstCredit === undefined || credits.some((item) => !item.quantity.isPositive())) {
    return unresolved('incomplete');
  }
  const anchorDate = firstCredit.tradeDate;
  if (credits.some((item) => item.tradeDate !== anchorDate)) return unresolved('ambiguous');
  if (!Number.isInteger(input.windowDays) || input.windowDays < 0) {
    return unresolved('outside_window');
  }

  const redemptions: LiquidationEvidence[] = [];
  for (const source of definition.sources) {
    const own = input.evidence.filter(
      (item) => item.role === 'source_redemption' && item.assetCode === source.assetCode,
    );
    const inWindow = own.filter(
      (item) => Math.abs(dayNumber(item.tradeDate) - dayNumber(anchorDate)) <= input.windowDays,
    );
    const [only, ...others] = inWindow;
    // BR-005-17 (#149 review F1): the credits alone never liquidate. A file
    // ending between the receipts and the cash must leave everything as it is.
    if (only === undefined) return unresolved(own.length > 0 ? 'outside_window' : 'incomplete');
    if (others.length > 0) return unresolved('ambiguous');
    // A liquidation redeems every share. A `Resgate` of any other quantity
    // means the ledger's history is not B3's, and a liquidation value applied
    // to it would realise a result on shares the owner may not hold.
    const held = only.heldBefore ?? null;
    if (held === null || !held.equals(only.quantity)) {
      return unresolved('quantity_mismatch');
    }
    redemptions.push(only);
  }

  const group = [...redemptions, ...credits];
  if (group.some((item) => item.state === 'locked')) return unresolved('user_modified');
  if (group.every((item) => item.state === 'applied')) {
    return { status: 'applied', definitionId: definition.id, anchorDate };
  }

  const sales: LiquidationWritePlan[] = definition.sources.map((source, index) => {
    const redemption = redemptions[index] as LiquidationEvidence;
    return {
      evidenceId: redemption.id,
      type: 'sell',
      assetCode: source.assetCode,
      tradeDate: redemption.tradeDate,
      quantity: redemption.quantity,
      unitPrice: source.liquidationValue,
    };
  });
  const subscriptions: LiquidationWritePlan[] = credits.map((credit) => ({
    evidenceId: credit.id,
    type: 'subscription',
    assetCode: definition.target.assetCode,
    tradeDate: credit.tradeDate,
    quantity: credit.quantity,
    unitPrice: definition.target.unitCost,
  }));
  const open = new Set(group.filter((item) => item.state === 'open').map((item) => item.id));
  const valueOf = (plan: LiquidationWritePlan) =>
    computeTotalValue(plan.type, plan.quantity, plan.unitPrice, Money.zero());

  return {
    status: 'resolved',
    definitionId: definition.id,
    anchorDate,
    writes: [...sales, ...subscriptions].filter((plan) => open.has(plan.evidenceId)),
    proceeds: sumMoney(sales.map(valueOf)),
    acquisitionCost: sumMoney(subscriptions.map(valueOf)),
  };
}
