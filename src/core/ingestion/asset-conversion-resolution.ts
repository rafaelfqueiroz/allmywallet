import type { BusinessDate } from '@/core/shared/clock';
import { asStored, Money, Quantity, sumMoney } from '@/core/shared/money';
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
  readonly totalValue: Money;
}

export interface AssetConversionSourcePlan {
  readonly assetCode: string;
  readonly quantity: Quantity;
  readonly removedCost: Money;
}

export interface ResolvedAssetConversion {
  readonly status: 'resolved';
  readonly definitionId: string;
  /** Deterministic lookup key, deliberately not a UUID-shaped ConversionGroupId. */
  readonly groupKey: string;
  readonly legs: readonly AssetConversionLegPlan[];
  readonly sources: readonly AssetConversionSourcePlan[];
  readonly totalCost: Money;
}

export type AssetConversionUnresolvedReason =
  | 'incomplete'
  | 'ambiguous'
  | 'outside_window'
  | 'insufficient_quantity'
  | 'missing_cost'
  | 'negative_cost'
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

function isPermittedRepeatedEvidence(items: readonly AssetConversionEvidence[]): boolean {
  return (
    items.length <= 1 ||
    (items.every((item) => item.movement === 'transfer_in') &&
      items.every((item) => item.tradeDate === items[0]?.tradeDate))
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

function targetAllocations(
  targets: readonly AssetConversionTargetDefinition[],
  totalCost: Money,
): readonly Money[] | null {
  if (targets.length === 1) return [totalCost];
  const weights = targets.map((target) => target.allocationWeight);
  if (weights.some((weight) => weight === null || !weight.isPositive())) return null;
  const concreteWeights = weights.filter((weight): weight is Quantity => weight !== null);
  const weightTotal = concreteWeights.reduce((sum, weight) => sum.plus(weight), Quantity.zero());
  if (!weightTotal.isPositive()) return null;

  const allocations: Money[] = [];
  let allocated = Money.zero();
  for (let index = 0; index < targets.length; index += 1) {
    if (index === targets.length - 1) {
      // BR-005-20c: storage-scale residual belongs deterministically to the final target.
      allocations.push(totalCost.minus(allocated));
      continue;
    }
    const weight = concreteWeights[index];
    if (weight === undefined) return null;
    const allocation = storedMoney(totalCost.times(weight).dividedBy(weightTotal));
    allocations.push(allocation);
    allocated = allocated.plus(allocation);
  }
  return allocations;
}

/**
 * SPEC-005 BR-005-20c / SPEC-007 BR-007-05b: plans an all-or-nothing group.
 * It never guesses a relationship, cost or multi-target allocation.
 */
export function resolveAssetConversion(
  input: ResolveAssetConversionInput,
): AssetConversionResolution {
  if (input.evidence.length === 0 || input.sourcePositions.length === 0) {
    return unresolved('incomplete');
  }
  const evidenceGroups = groupedByCode(input.evidence);
  if (
    [...evidenceGroups.values()].some((items) => !isPermittedRepeatedEvidence(items)) ||
    uniqueByCode(input.sourcePositions) === null
  ) {
    return unresolved('ambiguous');
  }
  const matching = input.definitions.filter((definition) =>
    matchesDefinition(definition, input.evidence, input.sourcePositions),
  );
  if (matching.length === 0) return unresolved('incomplete');
  if (matching.length > 1) return unresolved('ambiguous');
  const definition = matching[0];
  if (definition === undefined) return unresolved('incomplete');

  const days = input.evidence.map((item) => dayNumber(item.tradeDate));
  const earliest = Math.min(...days);
  const latest = Math.max(...days);
  if (!Number.isInteger(input.conversionWindowDays) || input.conversionWindowDays < 0) {
    return unresolved('outside_window');
  }
  if (latest - earliest > input.conversionWindowDays) return unresolved('outside_window');

  const evidenceByCode = groupedByCode(input.evidence);
  const positionsByCode = uniqueByCode(input.sourcePositions);
  if (positionsByCode === null) return unresolved('ambiguous');
  const sourcePlans: AssetConversionSourcePlan[] = [];
  for (const sourceCode of definition.sourceAssetCodes) {
    const position = positionsByCode.get(sourceCode);
    if (position === undefined || !position.quantity.isPositive()) {
      return unresolved('insufficient_quantity');
    }
    const sourceEvidence = evidenceByCode.get(sourceCode)?.[0];
    const remaining = sourceEvidence?.statementQuantity ?? Quantity.zero();
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
    sourcePlans.push({
      assetCode: sourceCode,
      quantity: removed,
      removedCost,
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

  const totalCost = storedMoney(sumMoney(sourcePlans.map((plan) => plan.removedCost)));
  const allocations = targetAllocations(definition.targets, totalCost);
  if (allocations === null) return unresolved('missing_allocation_weights');

  const groupKey = groupIdentity(definition, input.evidence, input.sourcePositions);
  const fallbackDate = targetPlans[0]?.evidence[0]?.evidence.tradeDate;
  if (fallbackDate === undefined) return unresolved('incomplete');
  const outLegs = sourcePlans.map(({ assetCode, quantity }) => {
    const evidence = evidenceByCode.get(assetCode)?.[0];
    return {
      key: `${groupKey}:out:${assetCode}`,
      type: 'conversion_out' as const,
      evidenceId: evidence?.id ?? null,
      assetCode,
      tradeDate: evidence?.tradeDate ?? fallbackDate,
      quantity,
      costBasis: sourcePlans.find((source) => source.assetCode === assetCode)?.removedCost ?? null,
      totalValue: Money.zero(),
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
        totalValue: Money.zero(),
      };
    });
  });

  return {
    status: 'resolved',
    definitionId: definition.id,
    groupKey,
    legs: [...outLegs, ...inLegs],
    sources: sourcePlans,
    totalCost,
  };
}
