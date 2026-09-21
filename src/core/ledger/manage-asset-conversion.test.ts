import { describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import { ConversionGroupId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import {
  createAssetConversionGroup,
  deleteAssetConversionGroup,
  replaceAssetConversionGroup,
  validateAssetConversionGroup,
} from '@/core/ledger/manage-asset-conversion';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';

const clock = new FakeClock('2026-06-30T12:00:00Z');

function groupLegs(group: string, outgoingQuantity = '40', cost = '400') {
  return [
    aTransaction()
      .conversionOut(group, cost)
      .of('OLD3')
      .on('2026-02-01')
      .quantity(outgoingQuantity)
      .build(),
    aTransaction().conversionIn(cost, group).of('NEW3').on('2026-02-01').quantity('20').build(),
  ] as const;
}

function depsWithSource() {
  resetTransactionSequence();
  const source = aTransaction()
    .buy()
    .of('OLD3')
    .on('2026-01-01')
    .quantity('100')
    .price('10')
    .build();
  return {
    transactions: new FakeTransactionRepository([source]),
    positions: new FakePositionRepository(),
    clock,
  };
}

describe('SPEC-006 BR-006-05 — atomic conversion group management', () => {
  it('refuses a singleton and a group whose incoming cost does not equal outgoing cost', () => {
    const group = '00000000-c0de-7000-8000-000000000021';
    const valid = groupLegs(group);
    expect(validateAssetConversionGroup([valid[0]]).ok).toBe(false);
    const mismatched = [
      valid[0],
      { ...valid[1], costBasis: valid[1].costBasis!.plus(Money.fromString('0.00000001')) },
    ];
    const result = validateAssetConversionGroup(mismatched);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONVERSION_GROUP');
  });

  it('creates, replaces and deletes every leg as one complete group', async () => {
    const deps = depsWithSource();
    const group = '00000000-c0de-7000-8000-000000000022';
    const created = await createAssetConversionGroup(deps, groupLegs(group));
    expect(created.ok).toBe(true);
    expect(await deps.transactions.listByConversionGroup(ConversionGroupId.of(group))).toHaveLength(
      2,
    );

    const replacement = groupLegs(group, '50', '500');
    const replaced = await replaceAssetConversionGroup(
      deps,
      ConversionGroupId.of(group),
      replacement,
    );
    expect(replaced.ok).toBe(true);
    const stored = await deps.transactions.listByConversionGroup(ConversionGroupId.of(group));
    expect(stored).toHaveLength(2);
    expect(stored.find((leg) => leg.type === 'conversion_out')?.quantity.toString()).toBe('50');

    const deleted = await deleteAssetConversionGroup(deps, ConversionGroupId.of(group));
    expect(deleted.ok).toBe(true);
    expect(deleted.ok && deleted.value.deletedCount).toBe(2);
    expect(await deps.transactions.listByConversionGroup(ConversionGroupId.of(group))).toEqual([]);
  });
});
