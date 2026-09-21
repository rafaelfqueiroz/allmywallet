import type { BusinessDate } from '@/core/shared/clock';
import { asStored, Money, Quantity, sumMoney } from '@/core/shared/money';
import { computeTotalValue } from '@/core/ledger/transaction';
import type {
  AssetConversionDefinition,
  AssetConversionTargetDefinition,
} from '@/core/ingestion/asset-conversion-definitions';
import { ASSET_CONVERSION_DEFINITIONS_VERSION } from '@/core/ingestion/asset-conversion-definitions';
import type { AssetConversionEvidenceMovement } from '@/core/ingestion/movement-map';

export interface AssetConversionEvidence {
  readonly id: string;
  readonly movement: AssetConversionEvidenceMovement;
  readonly assetCode: string;
  readonly tradeDate: BusinessDate;
  readonly beforeQuantity: Quantity;
  /** Absolute balance B3 states after the event, not a transaction quantity. */
  readonly statementQuantity: Quantity;
  /**
   * #143 — the price and fees B3 states on a **priced** `Resgate`, read only
   * for a source its definition names in `pricedRedemptionSourceCodes`. Absent
   * (or zero) on every other row: B3's conversion evidence carries no price.
   */
  readonly unitPrice?: Money | undefined;
  readonly fees?: Money | undefined;
}

export interface AssetConversionSourcePosition {
  readonly assetCode: string;
  readonly quantity: Quantity;
  /** Null means replay could not establish cost; exact zero is valid. */
  readonly totalCost: Money | null;
}

export interface AssetConversionLegPlan {
  /** Deterministic idempotency key; commit maps its group key to a UUID. */
  readonly key: string;
  readonly type: 'conversion_out' | 'conversion_in';
  readonly evidenceId: string | null;
  readonly assetCode: string;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  /** SPEC-006 BR-006-05: both directions persist the same exact removed/allocated cost. */
  readonly costBasis: Money | null;
  /**
   * #143 — B3's stated price and fees on a cash-bearing `conversion_out`, and
   * the cash they give (`computeTotalValue`, at the storage scale). Zero on
   * every other leg.
   */
  readonly unitPrice: Money;
  readonly fees: Money;
  readonly totalValue: Money;
}

export interface AssetConversionSourcePlan {
  readonly assetCode: string;
  readonly quantity: Quantity;
  readonly removedCost: Money;
  /** #143: the cash component B3 paid on this source; zero unless its redemption was priced. */
  readonly cash: Money;
}

export interface ResolvedAssetConversion {
  readonly status: 'resolved';
  readonly definitionId: string;
  /** Deterministic lookup key, deliberately not a UUID-shaped ConversionGroupId. */
  readonly groupKey: string;
  readonly legs: readonly AssetConversionLegPlan[];
  readonly sources: readonly AssetConversionSourcePlan[];
  /** The cost the incoming legs carry: Σ removed − Σ cash (#143). */
  readonly totalCost: Money;
  /** #143: Σ cash on the outgoing legs — a return of capital, never a gain. */
  readonly cash: Money;
}

export type AssetConversionUnresolvedReason =
  | 'incomplete'
  | 'ambiguous'
  | 'outside_window'
  | 'insufficient_quantity'
  | 'missing_cost'
  | 'negative_cost'
  /** #143: a priced redemption whose fees exceed its proceeds. */
  | 'negative_cash'
  | 'missing_allocation_weights';

export interface UnresolvedAssetConversion {
  readonly status: 'unresolved';
  readonly reason: AssetConversionUnresolvedReason;
}

export type AssetConversionResolution = ResolvedAssetConversion | UnresolvedAssetConversion;

export interface ResolveAssetConversionInput {
  readonly definitions: readonly AssetConversionDefinition[];
  readonly evidence: readonly AssetConversionEvidence[];
  readonly sourcePositions: readonly AssetConversionSourcePosition[];
  /** Configured by the caller; the pure resolver has no hidden default. */
  readonly conversionWindowDays: number;
}

const unresolved = (reason: AssetConversionUnresolvedReason): UnresolvedAssetConversion => ({
  status: 'unresolved',
  reason,
});

function dayNumber(date: BusinessDate): number {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return Number.NaN;
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function uniqueByCode<T extends { readonly assetCode: string }>(
  items: readonly T[],
): Map<string, T> | null {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.assetCode)) return null;
    result.set(item.assetCode, item);
  }
  return result;
}

function groupedByCode<T extends { readonly assetCode: string }>(
  items: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const result = new Map<string, T[]>();
  for (const item of items)
    result.set(item.assetCode, [...(result.get(item.assetCode) ?? []), item]);
  return result;
}

/**
 * Same-code evidence may repeat only where each row is a delta rather than a
 * restated balance: price-less `Transferência` credits (#121), and — #143 —
 * same-day target `Atualização` credits of a definition that says so
 * (`repeatedTargetCredits`). Anywhere else two statements of one code are two
 * readings of one balance, and choosing between them would be a guess.
 */
function isPermittedRepeatedEvidence(
  items: readonly AssetConversionEvidence[],
  definitions: readonly AssetConversionDefinition[],
): boolean {
  if (items.length <= 1) return true;
  const sameDay = items.every((item) => item.tradeDate === items[0]?.tradeDate);
  if (!sameDay) return false;
  if (items.every((item) => item.movement === 'transfer_in')) return true;
  const code = items[0]?.assetCode;
  return (
    items.every((item) => item.movement === 'atualizacao') &&
    definitions.some(
      (definition) =>
        definition.repeatedTargetCredits === true &&
        definition.targets.some(
          (target) => (target.evidenceAssetCode ?? target.assetCode) === code,
        ),
    )
  );
}

function matchesDefinition(
  definition: AssetConversionDefinition,
  evidence: readonly AssetConversionEvidence[],
  sourcePositions: readonly AssetConversionSourcePosition[],
): boolean {
  const sourceCodes = new Set(definition.sourceAssetCodes);
  const targetCodes = new Set(
    definition.targets.map((target) => target.evidenceAssetCode ?? target.assetCode),
  );
  const expectedCodes = new Set([...sourceCodes, ...targetCodes]);
  const actualSourceCodes = new Set(sourcePositions.map((position) => position.assetCode));
  if (
    sourceCodes.size !== actualSourceCodes.size ||
    ![...sourceCodes].every((code) => actualSourceCodes.has(code))
  ) {
    return false;
  }
  if (!evidence.every((item) => expectedCodes.has(item.assetCode))) return false;
  return [...targetCodes].every((code) => evidence.some((item) => item.assetCode === code));
}

function storedMoney(value: Money): Money {
  return Money.fromString(asStored(value));
}

function groupIdentity(
  definition: AssetConversionDefinition,
  evidence: readonly AssetConversionEvidence[],
  sources: readonly AssetConversionSourcePosition[],
): string {
  const rows = [...evidence]
    .map((item) => `${item.tradeDate}:${item.assetCode}:${item.id}`)
    .sort()
    .join('|');
  const holdings = [...sources]
    .map(
      (source) =>
        `${source.assetCode}:${source.quantity.toString()}:${source.totalCost?.toString() ?? 'missing'}`,
    )
    .sort()
    .join('|');
  return `conversion:v${ASSET_CONVERSION_DEFINITIONS_VERSION}:${definition.id}:${rows}:${holdings}`;
}

/**
 * BR-005-20c — how a group's carried cost divides between its targets.
 *
 * A weight of **zero** is permitted (#129 D3): it says B3 put shares on this
 * target and attributed no value to them, which is the same reading a
 * `bonificacao` already takes of a quantity B3 states without a price
 * (SPEC-007 BR-007-05, "B3's attributed value **or zero**"). CPLE6 converts
 * into CPLE3 and a redeemable CPLE7 that B3 immediately cashes out; B3 states
 * both quantities and no cost split, so the whole basis stays with CPLE3 and
 * the redemption realises its full proceeds. At least one weight must still be
 * positive — an all-zero split would lose the cost entirely.
 *
 * The storage-scale residual goes to the last **positive-weight** target
 * rather than simply the last: a zero-weight target in final position would
 * otherwise absorb the rounding and stop being zero-cost, which is exactly
 * what the weight asserts.
 */
function targetAllocations(
  targets: readonly AssetConversionTargetDefinition[],
  totalCost: Money,
): readonly Money[] | null {
  if (targets.length === 1) return [totalCost];
  const weights = targets.map((target) => target.allocationWeight);
  if (weights.some((weight) => weight === null || weight.isNegative())) return null;
  const concreteWeights = weights.filter((weight): weight is Quantity => weight !== null);
  const weightTotal = concreteWeights.reduce((sum, weight) => sum.plus(weight), Quantity.zero());
  if (!weightTotal.isPositive()) return null;
  const residualIndex = concreteWeights.reduce(
    (last, weight, index) => (weight.isPositive() ? index : last),
    -1,
  );
  if (residualIndex < 0) return null;

  const allocations: Money[] = [];
  let allocated = Money.zero();
  for (let index = 0; index < targets.length; index += 1) {
    if (index === residualIndex) {
      // Filled in below, once every other target has taken its share.
      allocations.push(Money.zero());
      continue;
    }
    const weight = concreteWeights[index];
    if (weight === undefined) return null;
    const allocation = storedMoney(totalCost.times(weight).dividedBy(weightTotal));
    allocations.push(allocation);
    allocated = allocated.plus(allocation);
  }
  // BR-005-20c: the storage-scale residual belongs deterministically to one target.
  allocations[residualIndex] = totalCost.minus(allocated);
  return allocations;
}

/**
 * SPEC-005 BR-005-20c (#143) — a **source** `Atualização` that restates the
 * balance the replay already holds is corroboration, not conversion evidence.
 *
 * B3 restated BPFF11's 90 on 2025-10-06, a week before the `Resgate` that
 * actually removed them; RVBI11's 159,25 on 2025-10-17 likewise, before the
 * rename. Read as *what remains after the conversion*, the statement leaves
 * nothing removed and the whole group refuses `insufficient_quantity` — so the
 * statement is set aside, and the source contributes what the rest of the
 * group says it did (its priced `Resgate`, or its whole position where the
 * evidence is target-only).
 *
 * Only an **exactly** unchanged balance, only an `Atualização`, only on a code
 * a definition sources **and** opts in with `sourceBalanceRestatements`. A statement that differs from the replay by any
 * amount is still read as what remains; a target's unchanged statement still
 * refuses as adding nothing. `beforeQuantity` is the replayed balance
 * immediately before the row's date (`commit-batch.ts`), which is why an
 * earlier statement cannot be confused with a later one.
 */
export function corroboratesSourceBalance(
  item: AssetConversionEvidence,
  definitions: readonly AssetConversionDefinition[],
): boolean {
  return (
    item.movement === 'atualizacao' &&
    item.statementQuantity.equals(item.beforeQuantity) &&
    definitions.some(
      (definition) =>
        definition.sourceBalanceRestatements === true &&
        definition.sourceAssetCodes.includes(item.assetCode),
    )
  );
}

/**
 * SPEC-005 BR-005-20c / SPEC-007 BR-007-05b: plans an all-or-nothing group.
 * It never guesses a relationship, cost or multi-target allocation.
 */
export function resolveAssetConversion(
  input: ResolveAssetConversionInput,
): AssetConversionResolution {
  const evidence = input.evidence.filter(
    (item) => !corroboratesSourceBalance(item, input.definitions),
  );
  if (evidence.length === 0 || input.sourcePositions.length === 0) {
    return unresolved('incomplete');
  }
  const evidenceGroups = groupedByCode(evidence);
  if (
    [...evidenceGroups.values()].some(
      (items) => !isPermittedRepeatedEvidence(items, input.definitions),
    ) ||
    uniqueByCode(input.sourcePositions) === null
  ) {
    return unresolved('ambiguous');
  }
  const matching = input.definitions.filter((definition) =>
    matchesDefinition(definition, evidence, input.sourcePositions),
  );
  if (matching.length === 0) return unresolved('incomplete');
  if (matching.length > 1) return unresolved('ambiguous');
  const definition = matching[0];
  if (definition === undefined) return unresolved('incomplete');

  const days = evidence.map((item) => dayNumber(item.tradeDate));
  const earliest = Math.min(...days);
  const latest = Math.max(...days);
  if (!Number.isInteger(input.conversionWindowDays) || input.conversionWindowDays < 0) {
    return unresolved('outside_window');
  }
  if (latest - earliest > input.conversionWindowDays) return unresolved('outside_window');

  const evidenceByCode = groupedByCode(evidence);
  const positionsByCode = uniqueByCode(input.sourcePositions);
  if (positionsByCode === null) return unresolved('ambiguous');
  const sourcePlans: Array<AssetConversionSourcePlan & { unitPrice: Money; fees: Money }> = [];
  for (const sourceCode of definition.sourceAssetCodes) {
    const position = positionsByCode.get(sourceCode);
    if (position === undefined || !position.quantity.isPositive()) {
      return unresolved('insufficient_quantity');
    }
    const sourceEvidence = evidenceByCode.get(sourceCode)?.[0];
    // #143 (review F1): a source whose definition names its priced redemption
    // converts only **with** that redemption. Target-only evidence alone — a
    // file ending between the receipts and the cash — would convert the whole
    // position at cash zero, carry the full cost, and leave the later
    // `Resgate` with no group to join; the result would depend on how the
    // files were split (BR-005-17).
    if (
      (definition.pricedRedemptionSourceCodes ?? []).includes(sourceCode) &&
      sourceEvidence?.movement !== 'resgate'
    ) {
      return unresolved('incomplete');
    }
    const remaining = sourceEvidence?.statementQuantity ?? Quantity.zero();
    const unitPrice = sourceEvidence?.unitPrice ?? Money.zero();
    const fees = sourceEvidence?.fees ?? Money.zero();
    const removed = position.quantity.minus(remaining);
    if (
      !removed.isPositive() ||
      remaining.isNegative() ||
      removed.comparedTo(position.quantity) > 0
    ) {
      return unresolved('insufficient_quantity');
    }
    if (position.totalCost === null) return unresolved('missing_cost');
    if (position.totalCost.isNegative()) return unresolved('negative_cost');
    // BR-007-05b: allocate once at the NUMERIC(20,8) storage boundary and
    // persist that exact amount on both legs. Recomputing `average * removed`
    // independently during replay can diverge at a half-unit in the 8th place.
    const removedCost = removed.equals(position.quantity)
      ? storedMoney(position.totalCost)
      : storedMoney(position.totalCost.times(removed).dividedBy(position.quantity));
    // #143: a price on the source's evidence is a cash component only where the
    // definition names that source's priced redemption. Anywhere else the
    // evidence is expected price-less, and a price would be a figure no rule
    // says what to do with.
    const priced = !unitPrice.isZero() || !fees.isZero();
    if (priced && !(definition.pricedRedemptionSourceCodes ?? []).includes(sourceCode)) {
      return unresolved('incomplete');
    }
    // Allocated once at the storage boundary, from the leg's own fields, so the
    // persisted total and `externalFlow`'s recomputation are the same figure.
    const cash = storedMoney(computeTotalValue('conversion_out', removed, unitPrice, fees));
    if (cash.isNegative()) return unresolved('negative_cash');
    // #143 (review F6): per source, not only in total — one source's cash above
    // its own basis would otherwise be absorbed into another source's cost.
    if (cash.comparedTo(removedCost) > 0) return unresolved('negative_cost');
    sourcePlans.push({
      assetCode: sourceCode,
      quantity: removed,
      removedCost,
      cash,
      unitPrice,
      fees,
    });
  }

  const targetPlans: Array<{
    target: AssetConversionTargetDefinition;
    evidence: readonly { evidence: AssetConversionEvidence; quantity: Quantity }[];
  }> = [];
  for (const target of definition.targets) {
    const evidence = evidenceByCode.get(target.evidenceAssetCode ?? target.assetCode);
    if (evidence === undefined || evidence.length === 0) return unresolved('incomplete');
    const additions = evidence.map((item) => ({
      evidence: item,
      quantity: item.statementQuantity.minus(item.beforeQuantity),
    }));
    if (additions.some((item) => !item.quantity.isPositive())) return unresolved('incomplete');
    targetPlans.push({ target, evidence: additions });
  }

  /**
   * SPEC-007 BR-007-05b (#143): the cash B3 paid alongside the conversion is a
   * **return of capital** — it leaves the carried cost, and the incoming legs
   * receive what remains. Worked example (DV-17): 90 units at 9.000,00 and 70
   * at 7.265,32 redeemed for 201,51 and 138,81; the target receives
   * 16.265,32 − 340,32 = 15.925,00. Cash above the whole removed cost would
   * need a gain to cover it, and no gain is ever realised here: it refuses.
   */
  const removedTotal = storedMoney(sumMoney(sourcePlans.map((plan) => plan.removedCost)));
  const cashTotal = storedMoney(sumMoney(sourcePlans.map((plan) => plan.cash)));
  const totalCost = removedTotal.minus(cashTotal);
  if (totalCost.isNegative()) return unresolved('negative_cost');
  const allocations = targetAllocations(definition.targets, totalCost);
  if (allocations === null) return unresolved('missing_allocation_weights');

  const groupKey = groupIdentity(definition, evidence, input.sourcePositions);
  const fallbackDate = targetPlans[0]?.evidence[0]?.evidence.tradeDate;
  if (fallbackDate === undefined) return unresolved('incomplete');
  const outLegs = sourcePlans.map(({ assetCode, quantity, removedCost, cash, unitPrice, fees }) => {
    const evidence = evidenceByCode.get(assetCode)?.[0];
    return {
      key: `${groupKey}:out:${assetCode}`,
      type: 'conversion_out' as const,
      evidenceId: evidence?.id ?? null,
      assetCode,
      tradeDate: evidence?.tradeDate ?? fallbackDate,
      quantity,
      costBasis: removedCost,
      unitPrice,
      fees,
      totalValue: cash,
    };
  });
  const inLegs = targetPlans.flatMap(({ target, evidence }, targetIndex) => {
    const targetCost = allocations[targetIndex] ?? Money.zero();
    const targetQuantity = evidence.reduce((sum, item) => sum.plus(item.quantity), Quantity.zero());
    let allocated = Money.zero();
    return evidence.map(({ evidence: item, quantity }, evidenceIndex) => {
      const costBasis =
        evidenceIndex === evidence.length - 1
          ? targetCost.minus(allocated)
          : storedMoney(targetCost.times(quantity).dividedBy(targetQuantity));
      allocated = allocated.plus(costBasis);
      return {
        key: `${groupKey}:in:${target.assetCode}:${item.id}`,
        type: 'conversion_in' as const,
        evidenceId: item.id,
        assetCode: target.assetCode,
        tradeDate: item.tradeDate,
        quantity,
        costBasis,
        unitPrice: Money.zero(),
        fees: Money.zero(),
        totalValue: Money.zero(),
      };
    });
  });

  return {
    status: 'resolved',
    definitionId: definition.id,
    groupKey,
    legs: [...outLegs, ...inLegs],
    sources: sourcePlans.map(({ assetCode, quantity, removedCost, cash }) => ({
      assetCode,
      quantity,
      removedCost,
      cash,
    })),
    totalCost,
    cash: cashTotal,
  };
}
