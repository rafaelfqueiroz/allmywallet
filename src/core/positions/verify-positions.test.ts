import { beforeEach, describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { makePosition } from '@/core/positions/position-state';
import { verifyPositions } from '@/core/positions/rebuild';
import type { PositionSnapshot } from '@/core/positions/replay';

/**
 * DM-4 / DL-006-01 — "if a cache disagrees with a recomputation, the ledger
 * wins". That rule is only usable if the disagreement can be *seen*, which is
 * what `verifyPositions` is for and what `pnpm positions:rebuild --dry-run`
 * exposes to an operator.
 */

const PETR4 = assetIdFor('PETR4');

function deps(rows: Parameters<typeof FakeTransactionRepository.prototype.insert>[0][] = []) {
  return {
    transactions: new FakeTransactionRepository(rows),
    positions: new FakePositionRepository(),
  };
}

/** A cached position holding whatever figures a test wants to plant. */
function snapshot(quantity: string, totalCost: string, realizedGain = '0'): PositionSnapshot {
  return {
    assetId: PETR4,
    institutionId: null,
    state: makePosition(
      Quantity.fromString(quantity),
      Money.fromString(totalCost),
      Money.fromString(realizedGain),
    ),
  };
}

beforeEach(() => {
  resetTransactionSequence();
});

describe('verifyPositions', () => {
  it('reports no drift when the cache already agrees with the ledger', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build();
    const state = deps([buy]);
    await state.positions.upsertMany([snapshot('100', '1000')]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checked).toBe(1);
    expect(result.value.drift).toEqual([]);
  });

  it('names a position whose figures have moved, with both sides', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build();
    const state = deps([buy]);
    // The shape a real drift takes: a stale average from a fixed bug.
    await state.positions.upsertMany([snapshot('100', '1200')]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drift).toHaveLength(1);
    const [drift] = result.value.drift;
    expect(drift?.kind).toBe('changed');
    expect(drift?.cached?.averageCost).toBe('12.00000000');
    expect(drift?.rebuilt?.averageCost).toBe('10.00000000');
  });

  it('reports a position the cache never got', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build();
    const state = deps([buy]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drift.map((each) => each.kind)).toEqual(['missing_from_cache']);
    expect(result.value.drift[0]?.cached).toBeNull();
  });

  /**
   * The failure `deleteMany` exists to prevent, and the one a plain rebuild
   * repairs *silently* because `replaceAll` drops it. Worth naming: a position
   * with no ledger behind it means something deleted transactions without
   * recalculating, which is a bug somewhere else.
   */
  it('reports a cached position with no ledger behind it', async () => {
    const state = deps([]);
    await state.positions.upsertMany([snapshot('100', '1000')]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drift.map((each) => each.kind)).toEqual(['absent_from_ledger']);
    expect(result.value.drift[0]?.rebuilt).toBeNull();
  });

  it('writes nothing, whatever it finds', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build();
    const state = deps([buy]);
    await state.positions.upsertMany([snapshot('100', '1200')]);
    const writesBefore = state.positions.upsertCount + state.positions.replaceAllCount;

    await verifyPositions(state);

    // The whole point of separating the comparison from the write: `--dry-run`
    // has to be safe to run against production.
    expect(state.positions.upsertCount + state.positions.replaceAllCount).toBe(writesBefore);
  });

  /**
   * A ledger that cannot be replayed is a different and worse problem than a
   * drifted cache, and reporting it as "every position changed" would bury it.
   */
  it('returns the replay error rather than describing it as drift', async () => {
    const sell = aTransaction().sell().of('PETR4').at(null).quantity('50').price('10.00').build();
    const state = deps([sell]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
  });

  /**
   * The defect a live run found, and the reason this comparison is on the
   * *stored* form rather than on `toString()`.
   *
   * Three shares at 10,00 gives an average of 3,333333… carried to forty
   * digits in memory and stored as eight. Comparing the computed value against
   * the value read back reported drift immediately after a successful rebuild,
   * on every position whose replay produced a repeating decimal — which on the
   * reference workload was all one hundred of them.
   */
  it('does not report drift for precision the column cannot hold', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('3').price('10.00').build();
    const state = deps([buy]);
    // What NUMERIC(20,8) actually holds after that rebuild.
    await state.positions.upsertMany([snapshot('3', '30', '0')]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drift).toEqual([]);
  });

  it('still reports a difference that survives the stored scale', async () => {
    const buy = aTransaction().buy().of('PETR4').at(null).quantity('3').price('10.00').build();
    const state = deps([buy]);
    // One unit in the eighth place — the smallest difference the column can
    // represent, and the smallest this check must not round away.
    await state.positions.upsertMany([snapshot('3', '30.00000001', '0')]);

    const result = await verifyPositions(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drift.map((each) => each.kind)).toEqual(['changed']);
  });
});
