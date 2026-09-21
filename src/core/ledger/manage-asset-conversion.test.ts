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

describe('SPEC-007 BR-007-05b (#143) — a conversion group with a cash component', () => {
  const group = '00000000-c0de-7000-8000-000000000031';
  /**
   * Generated shape (DV-24): two sources incorporated into one target, each
   * redeemed for a stated cash amount.
   *   A: 90 units, cost 9.000,00, cash 90 × 2,239 = 201,51
   *   B: 70 units, cost 7.000,00, cash 70 × 1,983 = 138,81
   * Out cost 16.000,00 = in cost + cash 340,32 → in cost 15.659,68,
   * split 8.798,49 + 6.861,19 (any split conserves; this one is arbitrary).
   */
  function cashGroup(inTotals: readonly [string, string] = ['8798.49', '6861.19']) {
    return [
      aTransaction()
        .conversionOut(group, '9000')
        .of('SRCA11')
        .on('2025-10-14')
        .quantity('90')
        .price('2.239')
        .build(),
      aTransaction()
        .conversionOut(group, '7000')
        .of('SRCB11')
        .on('2025-10-14')
        .quantity('70')
        .price('1.983')
        .build(),
      aTransaction()
        .conversionIn(inTotals[0], group)
        .of('TGT11')
        .on('2025-10-06')
        .quantity('83.89')
        .build(),
      aTransaction()
        .conversionIn(inTotals[1], group)
        .of('TGT11')
        .on('2025-10-06')
        .quantity('75.36')
        .build(),
    ];
  }

  it('accepts Σ out cost = Σ in cost + Σ out cash', () => {
    const legs = cashGroup();
    // The builder derives each out total from its fields: 201,51 and 138,81.
    expect(legs[0]?.totalValue.toString()).toBe('201.51');
    expect(legs[1]?.totalValue.toString()).toBe('138.81');
    expect(validateAssetConversionGroup(legs).ok).toBe(true);
  });

  it('refuses a group whose in cost ignores the cash (the pre-#143 equality)', () => {
    // 16.000,00 in = 16.000,00 out, but 340,32 of cash would then be counted twice.
    const result = validateAssetConversionGroup(cashGroup(['9000', '7000']));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_CONVERSION_GROUP');
    expect(result.error.context).toMatchObject({
      outgoingCost: '16000',
      incomingCost: '16000',
      outgoingCash: '340.32',
    });
  });

  it('refuses cash on an incoming leg', () => {
    const legs = cashGroup();
    const incoming = legs[2]!;
    const withCash = { ...incoming, totalValue: Money.fromString('1') };
    expect(validateAssetConversionGroup([legs[0]!, legs[1]!, withCash, legs[3]!]).ok).toBe(false);
  });

  it('refuses an outgoing total that disagrees with its own quantity, price and fees', () => {
    // externalFlow recomputes 201,51 from the fields; a stored 200,00 would make
    // the conserved cash and the performance flow two different numbers — even
    // with the costs rebalanced so the sum itself holds.
    const legs = cashGroup(['8799.49', '6861.19']);
    const stale = { ...legs[0]!, totalValue: Money.fromString('200.51') };
    expect(validateAssetConversionGroup([stale, legs[1]!, legs[2]!, legs[3]!]).ok).toBe(false);
  });

  it('refuses a negative outgoing cash (fees larger than the proceeds)', () => {
    // 1 × 0,10 − 0,50 = −0,40: no conversion pays the investor a negative amount.
    const out = aTransaction()
      .conversionOut(group, '10')
      .of('SRCA11')
      .quantity('1')
      .price('0.10')
      .fees('0.50')
      .build();
    expect(out.totalValue.toString()).toBe('-0.4');
    const inLeg = aTransaction().conversionIn('10.4', group).of('TGT11').quantity('1').build();
    expect(validateAssetConversionGroup([out, inLeg]).ok).toBe(false);
  });
});
