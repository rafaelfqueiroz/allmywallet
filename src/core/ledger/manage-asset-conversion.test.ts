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
    // Out 400,00 against in 400,00000001: the two costs, and no cash figure.
    expect(result.error.context).toEqual({
      outgoingCost: '400',
      incomingCost: '400.00000001',
    });
  });

  it('BR-007-05b (#143) — refuses a leg carrying cash, even with the costs balanced', () => {
    // A conversion carries cost and never cash: out 400,00 = in 400,00 holds,
    // yet a total of 0,01 on either leg makes the group invalid. Asserting the
    // context pins the pre-#149 error: no cash figure is ever reported.
    const group = '00000000-c0de-7000-8000-000000000023';
    const [out, incoming] = groupLegs(group);
    expect(validateAssetConversionGroup([out, incoming]).ok).toBe(true);
    const cash = Money.fromString('0.01');
    for (const legs of [
      [{ ...out, totalValue: cash }, incoming],
      [out, { ...incoming, totalValue: cash }],
      [{ ...out, totalValue: cash.negated() }, incoming],
    ]) {
      const result = validateAssetConversionGroup(legs);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_CONVERSION_GROUP');
      expect(result.error.context).toEqual({});
    }
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

/**
 * SPEC-007 BR-007-06 / DL-007-12 — the estimate marker travels through a
 * conversion: an incoming leg's cost is carried from the sources' lots.
 */
describe('SPEC-007 BR-007-06 — conversion carries the estimate marker', () => {
  const group = '00000000-c0de-7000-8000-000000000031';

  /**
   * OLD3: buy 100 @ 10,00 (1.000,00) + estimated subscription 20 @ 114,90
   * (2.298,00) = 120 shares, 3.298,00, estimated. The conversion removes all
   * 120 at 3.298,00 and adds 60 NEW3 at 3.298,00: 54,9666… each, an estimate.
   */
  function estimatedSource(subscriptionDate = '2026-01-15') {
    resetTransactionSequence();
    return {
      transactions: new FakeTransactionRepository([
        aTransaction().buy().of('OLD3').on('2026-01-01').quantity('100').price('10').build(),
        aTransaction()
          .subscription()
          .of('OLD3')
          .on(subscriptionDate)
          .quantity('20')
          .price('114.90')
          .costEstimate(subscriptionDate)
          .build(),
      ]),
      positions: new FakePositionRepository(),
      clock,
    };
  }

  function wholeConversion() {
    return [
      aTransaction()
        .conversionOut(group, '3298')
        .of('OLD3')
        .on('2026-02-01')
        .quantity('120')
        .build(),
      aTransaction().conversionIn('3298', group).of('NEW3').on('2026-02-01').quantity('60').build(),
    ];
  }

  it('marks the incoming leg and its position when the source was estimated', async () => {
    const deps = estimatedSource();
    const created = await createAssetConversionGroup(deps, wholeConversion());
    expect(created.ok).toBe(true);

    const legs = await deps.transactions.listByConversionGroup(ConversionGroupId.of(group));
    const incoming = legs.find((leg) => leg.type === 'conversion_in');
    const outgoing = legs.find((leg) => leg.type === 'conversion_out');
    expect(incoming?.costIsEstimate).toBe(true);
    // A carried cost was read from no close (SPEC-005 BR-005-20d).
    expect(incoming?.estimateCloseDate).toBeNull();
    expect(outgoing?.costIsEstimate).toBe(false);

    const positions = await deps.positions.list();
    const target = positions.find((p) => p.state.quantity.toString() === '60');
    const source = positions.find((p) => p.state.quantity.isZero());
    expect(target?.state.totalCost.toString()).toBe('3298');
    expect(target?.costEstimated).toBe(true);
    // The source closed: its lot resets (BR-007-07).
    expect(source?.costEstimated).toBe(false);
  });

  it('leaves the incoming leg exact when the source’s estimate lands after the conversion', async () => {
    // Only the 100 @ 10,00 precede the outgoing leg.
    const deps = estimatedSource('2026-03-01');
    const legs = [
      aTransaction()
        .conversionOut(group, '1000')
        .of('OLD3')
        .on('2026-02-01')
        .quantity('100')
        .build(),
      aTransaction().conversionIn('1000', group).of('NEW3').on('2026-02-01').quantity('50').build(),
    ];
    expect((await createAssetConversionGroup(deps, legs)).ok).toBe(true);
    const stored = await deps.transactions.listByConversionGroup(ConversionGroupId.of(group));
    expect(stored.every((leg) => !leg.costIsEstimate)).toBe(true);
  });

  it('cannot be told a leg is estimated when its source is exact', async () => {
    const deps = depsWithSource();
    const [out, incoming] = groupLegs(group);
    // A form cannot invent the marker: it is decided from the ledger.
    const claimed = { ...incoming, costIsEstimate: true };
    expect((await createAssetConversionGroup(deps, [out, claimed])).ok).toBe(true);
    const stored = await deps.transactions.listByConversionGroup(ConversionGroupId.of(group));
    expect(stored.every((leg) => !leg.costIsEstimate)).toBe(true);
    expect((await deps.positions.list()).every((p) => !p.costEstimated)).toBe(true);
  });

  it('recomputes the marker on replacement, so a re-allocation cannot drop it', async () => {
    const deps = estimatedSource();
    expect((await createAssetConversionGroup(deps, wholeConversion())).ok).toBe(true);

    // The replacement arrives unmarked, as a form submission would.
    const replacement = wholeConversion().map((leg) => ({ ...leg, costIsEstimate: false }));
    const replaced = await replaceAssetConversionGroup(
      deps,
      ConversionGroupId.of(group),
      replacement,
    );
    expect(replaced.ok).toBe(true);
    const stored = await deps.transactions.listByConversionGroup(ConversionGroupId.of(group));
    expect(stored.find((leg) => leg.type === 'conversion_in')?.costIsEstimate).toBe(true);
  });
});
