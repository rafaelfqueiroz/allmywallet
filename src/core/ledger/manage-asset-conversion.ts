import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { ConversionGroupId } from '@/core/shared/ids';
import { Money, sumMoney } from '@/core/shared/money';
import { type Result, err, ok } from '@/core/shared/result';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { LedgerErrorCode, ledgerError } from '@/core/ledger/errors';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import { recalculatePositionFrom } from '@/core/ledger/recalculate-from';
import type { Transaction } from '@/core/ledger/transaction';
import { loadAmortizationTerms } from '@/core/positions/amortization';
import { compareForReplay } from '@/core/positions/ordering';
import {
  positionKeyString,
  type PositionKey,
  replayPositionWithEstimate,
} from '@/core/positions/replay';

/** SPEC-006 BR-006-05 / SPEC-007 BR-007-05b: validate the whole event, never one leg. */
export function validateAssetConversionGroup(
  legs: readonly Transaction[],
): Result<ConversionGroupId, DomainError> {
  const groupId = legs[0]?.conversionGroupId ?? null;
  const outgoing = legs.filter((leg) => leg.type === 'conversion_out');
  const incoming = legs.filter((leg) => leg.type === 'conversion_in');
  const ids = new Set(legs.map((leg) => leg.id));
  const structurallyComplete =
    groupId !== null &&
    legs.length >= 2 &&
    ids.size === legs.length &&
    outgoing.length > 0 &&
    incoming.length > 0 &&
    legs.every(
      (leg) =>
        (leg.type === 'conversion_out' || leg.type === 'conversion_in') &&
        leg.status === 'active' &&
        leg.conversionGroupId === groupId &&
        leg.costBasis !== null &&
        !leg.costBasis.isNegative() &&
        leg.totalValue.isZero(),
    );
  if (!structurallyComplete) {
    return err(ledgerError(LedgerErrorCode.INVALID_CONVERSION_GROUP));
  }
  const outgoingCost = sumMoney(outgoing.map((leg) => leg.costBasis ?? Money.zero()));
  const incomingCost = sumMoney(incoming.map((leg) => leg.costBasis ?? Money.zero()));
  if (!outgoingCost.equals(incomingCost)) {
    return err(
      ledgerError(LedgerErrorCode.INVALID_CONVERSION_GROUP, {
        outgoingCost: outgoingCost.toString(),
        incomingCost: incomingCost.toString(),
      }),
    );
  }
  return ok(groupId);
}

/**
 * What a conversion-group write hands back. `fromDate` is the earliest date
 * whose derived figures are now stale across every position the group touched
 * (SPEC-009 BR-009-18 / DL-006-03) — the boundary the app layer requests a
 * snapshot rebuild from.
 */
export interface AssetConversionWrite {
  readonly groupId: ConversionGroupId;
  readonly fromDate: BusinessDate;
}

export interface AssetConversionDelete {
  readonly deletedCount: number;
  readonly fromDate: BusinessDate;
}

export async function createAssetConversionGroup(
  deps: LedgerDependencies,
  legs: readonly Transaction[],
): Promise<Result<AssetConversionWrite, DomainError>> {
  const valid = validateAssetConversionGroup(legs);
  if (!valid.ok) return valid;
  const guarded = await guardReplacement(deps, [], legs);
  if (!guarded.ok) return guarded;
  const marked = await withSourceEstimate(deps, [], legs);
  await deps.transactions.insertMany(marked);
  const recalculated = await recalculateTouched(deps, [], marked);
  if (!recalculated.ok) return recalculated;
  return ok({ groupId: valid.value, fromDate: recalculated.value });
}

export async function replaceAssetConversionGroup(
  deps: LedgerDependencies,
  groupId: ConversionGroupId,
  replacements: readonly Transaction[],
): Promise<Result<AssetConversionWrite, DomainError>> {
  const existing = await deps.transactions.listByConversionGroup(groupId);
  if (existing.length === 0) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { conversionGroupId: groupId }));
  }
  const valid = validateAssetConversionGroup(replacements);
  if (!valid.ok) return valid;
  if (valid.value !== groupId) {
    return err(ledgerError(LedgerErrorCode.INVALID_CONVERSION_GROUP));
  }
  const guarded = await guardReplacement(deps, existing, replacements);
  if (!guarded.ok) return guarded;
  const marked = await withSourceEstimate(deps, existing, replacements);
  await deps.transactions.deleteByIds(existing.map((leg) => leg.id));
  await deps.transactions.insertMany(marked);
  const recalculated = await recalculateTouched(deps, existing, marked);
  if (!recalculated.ok) return recalculated;
  return ok({ groupId, fromDate: recalculated.value });
}

export async function deleteAssetConversionGroup(
  deps: LedgerDependencies,
  groupId: ConversionGroupId,
): Promise<Result<AssetConversionDelete, DomainError>> {
  const existing = await deps.transactions.listByConversionGroup(groupId);
  if (existing.length === 0) {
    return err(ledgerError(LedgerErrorCode.TRANSACTION_NOT_FOUND, { conversionGroupId: groupId }));
  }
  const valid = validateAssetConversionGroup(existing);
  if (!valid.ok) return valid;
  const guarded = await guardReplacement(deps, existing, []);
  if (!guarded.ok) return guarded;
  const deletedCount = await deps.transactions.deleteByIds(existing.map((leg) => leg.id));
  const recalculated = await recalculateTouched(deps, existing, []);
  if (!recalculated.ok) return recalculated;
  return ok({ deletedCount, fromDate: recalculated.value });
}

/**
 * SPEC-007 BR-007-06 / DL-007-12 — the cost-estimate marker travels through a
 * conversion. Each `conversion_in` leg's cost is allocated from what the
 * `conversion_out` legs removed (BR-007-05b), so when any source's open lot
 * was an estimate immediately before its outgoing leg — in replay order, on
 * the ledger as it will be once the group is written — every incoming leg is
 * marked. Decided here from the ledger rather than taken from the caller, so a
 * form submission can neither drop the marker nor invent one; recomputed on
 * every replacement, so editing a group's allocation never makes an estimated
 * source's cost look exact.
 *
 * Outgoing legs are never marked: they remove cost at the average and cannot
 * mark a position (`core/positions/cost-estimate.ts`). No close date on a
 * marked leg — its cost was read from no close (see `withCarriedCost`).
 *
 * Worked example: A holds 100 @ 10,00 plus an estimated subscription of 20 @
 * 114,90 (120 shares, 3.298,00, estimated). A conversion removes all 120 at
 * 3.298,00 and adds 60 B at that cost: B's 60 @ 54,9666… is an estimate too.
 */
async function withSourceEstimate(
  deps: LedgerDependencies,
  existing: readonly Transaction[],
  legs: readonly Transaction[],
): Promise<readonly Transaction[]> {
  const removed = new Set<string>(existing.map((leg) => leg.id));
  let estimated = false;
  // SPEC-007 BR-007-05c: a source with an amortization replays only with its
  // terms; without them the prefix would fail and the marker be lost.
  const amortization = await loadAmortizationTerms(
    deps.transactions,
    legs.map((leg) => leg.assetId),
  );
  for (const out of legs.filter((leg) => leg.type === 'conversion_out')) {
    const ledger = await deps.transactions.listForPosition(out.assetId, out.institutionId);
    const before = without(ledger, removed).filter(
      (transaction) => compareForReplay(transaction, out) < 0,
    );
    const replayed = replayPositionWithEstimate(before, { amortization });
    // `guardReplacement` has already replayed this position with the group
    // in place, so its prefix replays too.
    if (replayed.ok && replayed.value.costEstimated) estimated = true;
  }
  return legs.map((leg) => ({
    ...leg,
    costIsEstimate: leg.type === 'conversion_in' && estimated,
    estimateCloseDate: null,
  }));
}

interface TouchedPosition {
  readonly key: PositionKey;
  readonly fromDate: BusinessDate;
}

function touchedPositions(
  existing: readonly Transaction[],
  replacements: readonly Transaction[],
): readonly TouchedPosition[] {
  const touched = new Map<string, TouchedPosition>();
  for (const leg of [...existing, ...replacements]) {
    const key: PositionKey = { assetId: leg.assetId, institutionId: leg.institutionId };
    const id = positionKeyString(key);
    const seen = touched.get(id);
    if (seen === undefined || leg.tradeDate < seen.fromDate) {
      touched.set(id, { key, fromDate: leg.tradeDate });
    }
  }
  return [...touched.values()];
}

async function guardReplacement(
  deps: LedgerDependencies,
  existing: readonly Transaction[],
  replacements: readonly Transaction[],
): Promise<Result<void, DomainError>> {
  const removed = new Set<string>(existing.map((leg) => leg.id));
  for (const touched of touchedPositions(existing, replacements)) {
    const guard = await guardReplayable(deps, touched.key, (ledger) => [
      ...without(ledger, removed),
      ...replacements.filter(
        (leg) =>
          leg.assetId === touched.key.assetId && leg.institutionId === touched.key.institutionId,
      ),
    ]);
    if (!guard.ok) return guard;
  }
  return ok(undefined);
}

async function recalculateTouched(
  deps: LedgerDependencies,
  existing: readonly Transaction[],
  replacements: readonly Transaction[],
): Promise<Result<BusinessDate, DomainError>> {
  const positions = touchedPositions(existing, replacements);
  let earliest: BusinessDate | null = null;
  for (const touched of positions) {
    const result = await recalculatePositionFrom(deps, {
      ...touched.key,
      fromDate: touched.fromDate,
    });
    if (!result.ok) return result;
    if (earliest === null || BusinessDate.isBefore(touched.fromDate, earliest)) {
      earliest = touched.fromDate;
    }
  }
  // A conversion group always has legs, so `positions` is never empty.
  return ok(earliest as BusinessDate);
}
