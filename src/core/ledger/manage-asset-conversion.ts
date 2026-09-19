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
import { positionKeyString, type PositionKey } from '@/core/positions/replay';

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

export async function createAssetConversionGroup(
  deps: LedgerDependencies,
  legs: readonly Transaction[],
): Promise<Result<{ readonly groupId: ConversionGroupId }, DomainError>> {
  const valid = validateAssetConversionGroup(legs);
  if (!valid.ok) return valid;
  const guarded = await guardReplacement(deps, [], legs);
  if (!guarded.ok) return guarded;
  await deps.transactions.insertMany(legs);
  const recalculated = await recalculateTouched(deps, [], legs);
  if (!recalculated.ok) return recalculated;
  return ok({ groupId: valid.value });
}

export async function replaceAssetConversionGroup(
  deps: LedgerDependencies,
  groupId: ConversionGroupId,
  replacements: readonly Transaction[],
): Promise<Result<{ readonly groupId: ConversionGroupId }, DomainError>> {
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
  await deps.transactions.deleteByIds(existing.map((leg) => leg.id));
  await deps.transactions.insertMany(replacements);
  const recalculated = await recalculateTouched(deps, existing, replacements);
  if (!recalculated.ok) return recalculated;
  return ok({ groupId });
}

export async function deleteAssetConversionGroup(
  deps: LedgerDependencies,
  groupId: ConversionGroupId,
): Promise<Result<{ readonly deletedCount: number }, DomainError>> {
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
  return ok({ deletedCount });
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
): Promise<Result<void, DomainError>> {
  for (const touched of touchedPositions(existing, replacements)) {
    const result = await recalculatePositionFrom(deps, {
      ...touched.key,
      fromDate: touched.fromDate,
    });
    if (!result.ok) return result;
  }
  return ok(undefined);
}
