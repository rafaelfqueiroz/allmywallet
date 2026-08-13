import { beforeEach, describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { aggregateAcrossInstitutions } from '@/core/positions/aggregate';
import { makePosition } from '@/core/positions/position-state';
import { replayPositions, type PositionSnapshot } from '@/core/positions/replay';

/** SPEC-007 BR-007-08 — aggregated across institutions for portfolio views. */
describe('aggregateAcrossInstitutions', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('AC — weights by cost, not by averaging the averages', () => {
    // Clear  100 PETR4 @ 20,00 → total cost  2.000,00
    // Rico   300 PETR4 @ 40,00 → total cost 12.000,00
    //
    //   correct (cost-weighted): 14.000,00 ÷ 400 = 35,00
    //   wrong   (mean of means): (20,00 + 40,00) ÷ 2 = 30,00
    //
    // The wrong figure is 14% low and entirely plausible, which is how it
    // survives review and reaches a tax return.
    const replayed = replayPositions([
      aTransaction().buy().of('PETR4').at('Clear').quantity('100').price('20.00').build(),
      aTransaction().buy().of('PETR4').at('Rico').quantity('300').price('40.00').build(),
    ]);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    const aggregated = aggregateAcrossInstitutions(replayed.value);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.state.quantity.toString()).toBe('400');
    expect(aggregated[0]?.state.totalCost.toString()).toBe('14000');
    expect(aggregated[0]?.state.averageCost.toString()).toBe('35');
    expect(aggregated[0]?.state.averageCost.toString()).not.toBe('30');
  });

  it('agrees with a single-institution replay of the same trades', () => {
    // TS-12's shape: a total must not depend on how the rows were grouped.
    // The same four trades, split across two institutions and then all at one,
    // must produce the same portfolio-level average.
    const split = replayPositions([
      aTransaction().buy().of('VALE3').at('Clear').quantity('100').price('20.00').fees('7').build(),
      aTransaction().buy().of('VALE3').at('Rico').quantity('300').price('40.00').fees('9').build(),
    ]);
    resetTransactionSequence();
    const together = replayPositions([
      aTransaction().buy().of('VALE3').at('Clear').quantity('100').price('20.00').fees('7').build(),
      aTransaction().buy().of('VALE3').at('Clear').quantity('300').price('40.00').fees('9').build(),
    ]);
    expect(split.ok && together.ok).toBe(true);
    if (!split.ok || !together.ok) return;

    const a = aggregateAcrossInstitutions(split.value);
    const b = aggregateAcrossInstitutions(together.value);

    // 100 × 20 + 7 + 300 × 40 + 9 = 2.007,00 + 12.009,00 = 14.016,00 over 400
    // 14.016,00 ÷ 400 = 35,04
    expect(a[0]?.state.totalCost.toString()).toBe('14016');
    expect(a[0]?.state.averageCost.toString()).toBe('35.04');
    expect(b[0]?.state.averageCost.toString()).toBe('35.04');
  });

  it('sums realized gain across institutions', () => {
    const snapshots: PositionSnapshot[] = [
      {
        assetId: assetIdFor('PETR4'),
        institutionId: null,
        state: makePosition(
          Quantity.fromString('10'),
          Money.fromString('100'),
          Money.fromString('30'),
        ),
      },
      {
        assetId: assetIdFor('PETR4'),
        institutionId: null,
        state: makePosition(
          Quantity.fromString('20'),
          Money.fromString('500'),
          Money.fromString('12.5'),
        ),
      },
    ];

    // quantity 30, total 600,00, average 600 ÷ 30 = 20,00, realized 42,50
    const aggregated = aggregateAcrossInstitutions(snapshots);
    expect(aggregated[0]?.state.quantity.toString()).toBe('30');
    expect(aggregated[0]?.state.averageCost.toString()).toBe('20');
    expect(aggregated[0]?.state.realizedGain.toString()).toBe('42.5');
  });

  it('keeps realized gain when every institution’s position has closed', () => {
    const snapshots: PositionSnapshot[] = [
      {
        assetId: assetIdFor('PETR4'),
        institutionId: null,
        state: makePosition(Quantity.zero(), Money.zero(), Money.fromString('200')),
      },
      {
        assetId: assetIdFor('PETR4'),
        institutionId: null,
        state: makePosition(Quantity.zero(), Money.zero(), Money.fromString('-50')),
      },
    ];

    const aggregated = aggregateAcrossInstitutions(snapshots);
    expect(aggregated[0]?.state.quantity.toString()).toBe('0');
    expect(aggregated[0]?.state.averageCost.toString()).toBe('0');
    // 200,00 + (−50,00) = 150,00 — a loss at one broker offsets a gain at the other.
    expect(aggregated[0]?.state.realizedGain.toString()).toBe('150');
  });

  it('keeps different assets apart and emits them in a deterministic order', () => {
    const replayed = replayPositions([
      aTransaction().buy().of('VALE3').at('Rico').quantity('10').price('60.00').build(),
      aTransaction().buy().of('PETR4').at('Clear').quantity('10').price('30.00').build(),
      aTransaction().buy().of('PETR4').at('Rico').quantity('10').price('40.00').build(),
    ]);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;

    const aggregated = aggregateAcrossInstitutions(replayed.value);
    expect(aggregated).toHaveLength(2);
    expect(aggregated.map((a) => a.assetId)).toEqual([...aggregated.map((a) => a.assetId)].sort());

    // PETR4: (300,00 + 400,00) ÷ 20 = 35,00
    const petr = aggregated.find((a) => a.assetId === assetIdFor('PETR4'));
    expect(petr?.state.averageCost.toString()).toBe('35');
  });

  it('sorts assets ascending however they arrive', () => {
    // Fed in deliberately descending order, so the comparator is exercised in
    // both directions. Determinism here is what lets a rebuild and the
    // incremental cache be compared element by element (DM-4).
    const ids = [assetIdFor('AAAA1'), assetIdFor('BBBB2'), assetIdFor('CCCC3')].sort();
    const snapshots: PositionSnapshot[] = [...ids].reverse().map((assetId) => ({
      assetId,
      institutionId: null,
      state: makePosition(Quantity.fromString('1'), Money.fromString('10'), Money.zero()),
    }));

    expect(aggregateAcrossInstitutions(snapshots).map((a) => a.assetId)).toEqual(ids);
  });

  it('aggregates nothing from nothing', () => {
    expect(aggregateAcrossInstitutions([])).toEqual([]);
  });
});
