import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { positionKeyString, replayPosition, replayPositions } from '@/core/positions/replay';

/**
 * TS-06 — corporate events tested **in combination**, not just individually.
 * Individually correct handlers that break in sequence is the realistic
 * failure, so the fixture below is one continuous history and the average is
 * checked at every single step.
 *
 * TS-07 — the same history is then fed in scrambled and backdated order and
 * must produce identical figures.
 */

function averageAt(transactions: readonly Transaction[], date: string) {
  const result = replayPosition(transactions, { asOf: BusinessDate.of(date) });
  if (!result.ok) throw new Error(`replay failed at ${date}: ${result.error.code}`);
  return result.value;
}

describe('TS-06 — buy → split → buy → bonificação → partial sell', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  /**
   * The whole sequence, worked out by hand before a line of it was run:
   *
   *  1. 2026-01-05  Buy 100 @ 20,00, fees 10,00
   *       total   = 100 × 20,00 + 10,00 = 2.010,00
   *       qty     = 100
   *       average = 2.010,00 ÷ 100       =    20,10
   *
   *  2. 2026-02-10  Split, ratio 2 (desdobramento 1:2)
   *       qty     = 100 × 2              =   200
   *       total   = 2.010,00             ← unchanged, no money moved
   *       average = 2.010,00 ÷ 200       =    10,05
   *
   *  3. 2026-03-15  Buy 100 @ 12,85, fees 5,00
   *       added   = 100 × 12,85 + 5,00   = 1.290,00
   *       total   = 2.010,00 + 1.290,00  = 3.300,00
   *       qty     = 200 + 100            =   300
   *       average = 3.300,00 ÷ 300       =    11,00
   *
   *  4. 2026-04-20  Bonificação 30 shares, nothing attributed
   *       qty     = 330
   *       total   = 3.300,00             ← free shares add no cost
   *       average = 3.300,00 ÷ 330       =    10,00
   *
   *  5. 2026-05-25  Sell 130 @ 25,00, fees 12,00
   *       realized= (25,00 − 10,00) × 130 − 12,00
   *               = 1.950,00 − 12,00     = 1.938,00
   *       qty     = 330 − 130            =   200
   *       total   = 3.300,00 − 10,00 × 130 = 2.000,00
   *       average =                          10,00  ← unchanged by a sale
   *       check     2.000,00 ÷ 200       =    10,00 ✓
   */
  function history(): Transaction[] {
    return [
      aTransaction().buy().on('2026-01-05').quantity('100').price('20.00').fees('10.00').build(),
      aTransaction().split().on('2026-02-10').ratio('2').build(),
      aTransaction().buy().on('2026-03-15').quantity('100').price('12.85').fees('5.00').build(),
      aTransaction().bonificacao().on('2026-04-20').quantity('30').price('0').build(),
      aTransaction().sell().on('2026-05-25').quantity('130').price('25.00').fees('12.00').build(),
    ];
  }

  const STEPS = [
    { date: '2026-01-05', quantity: '100', totalCost: '2010', average: '20.1', realized: '0' },
    { date: '2026-02-10', quantity: '200', totalCost: '2010', average: '10.05', realized: '0' },
    { date: '2026-03-15', quantity: '300', totalCost: '3300', average: '11', realized: '0' },
    { date: '2026-04-20', quantity: '330', totalCost: '3300', average: '10', realized: '0' },
    { date: '2026-05-25', quantity: '200', totalCost: '2000', average: '10', realized: '1938' },
  ] as const;

  it.each(STEPS)(
    'at $date holds $quantity at an average of $average',
    ({ date, quantity, totalCost, average, realized }) => {
      const state = averageAt(history(), date);
      expect(state.quantity.toString()).toBe(quantity);
      expect(state.totalCost.toString()).toBe(totalCost);
      expect(state.averageCost.toString()).toBe(average);
      expect(state.realizedGain.toString()).toBe(realized);
    },
  );

  it('TS-07 — arrives at the same figures however the rows are ordered on input', () => {
    const chronological = history();
    const expected = averageAt(chronological, '2026-12-31');

    // Reverse order, and a rotation that puts the split last — the shape a
    // backdated corporate event actually arrives in (BR-006-18): the trades
    // are already entered, then the event is discovered and inserted between
    // them.
    for (const scrambled of [
      [...chronological].reverse(),
      [chronological[0], chronological[2], chronological[3], chronological[4], chronological[1]],
      [chronological[4], chronological[1], chronological[0], chronological[3], chronological[2]],
    ]) {
      const state = averageAt(
        scrambled.filter((t): t is Transaction => t !== undefined),
        '2026-12-31',
      );
      expect(state.quantity.toString()).toBe(expected.quantity.toString());
      expect(state.totalCost.toString()).toBe(expected.totalCost.toString());
      expect(state.averageCost.toString()).toBe(expected.averageCost.toString());
      expect(state.realizedGain.toString()).toBe(expected.realizedGain.toString());
    }
  });

  it('TS-07 — a backdated split matches a ledger that always had it', () => {
    // Build the same five rows twice. The second build inserts the split
    // *after* every trade — which is what happens when a user notices a
    // missing corporate event months later — and must land on identical
    // figures, not merely similar ones.
    const alwaysThere = averageAt(history(), '2026-12-31');

    resetTransactionSequence();
    const rows = history();
    const [buy1, split, buy2, bonus, sell] = rows;
    if (!buy1 || !split || !buy2 || !bonus || !sell) throw new Error('fixture');
    const backdated = averageAt([buy1, buy2, bonus, sell, split], '2026-12-31');

    expect(backdated.averageCost.toString()).toBe(alwaysThere.averageCost.toString());
    expect(backdated.quantity.toString()).toBe(alwaysThere.quantity.toString());
    expect(backdated.realizedGain.toString()).toBe(alwaysThere.realizedGain.toString());
  });

  it('is wrong in a specific, detectable way if the split is dropped', () => {
    // Guards the guard: if BR-007-15's ordering were broken by *ignoring* the
    // event rather than misordering it, the numbers below are what a user
    // would see. Asserting they differ keeps the sequence test honest — a
    // fixture that passed either way would prove nothing.
    const withoutSplit = history().filter((t) => t.type !== 'split');
    const state = averageAt(withoutSplit, '2026-12-31');
    expect(state.quantity.toString()).not.toBe('200');
  });
});

describe('BR-007-15 — same-date ordering: the share-base event applies first', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('a split and a buy on the same date blend at the post-split average', () => {
    // Held from January: 100 @ 20,00 fees 10,00 → total 2.010,00, average 20,10
    // On 2026-02-10, two rows land on the same date:
    //   the split (ratio 2) applies first, from its ex-date:
    //       qty 200, total 2.010,00, average 10,05
    //   then the buy, which was printed at the post-split price:
    //       total   = 2.010,00 + 50 × 10,00 = 2.510,00
    //       qty     = 250
    //       average = 2.510,00 ÷ 250        = 10,04
    //
    // Applying the buy first instead would give 150 shares at 16,733…, then a
    // split to 300 shares at 8,366… — a *preço médio* 17% away from the right
    // one and a share count that matches no statement. The buy is built first,
    // so insertion order alone would produce exactly that wrong answer.
    const transactions = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('20.00').fees('10.00').build(),
      aTransaction().buy().on('2026-02-10').quantity('50').price('10.00').build(),
      aTransaction().split().on('2026-02-10').ratio('2').build(),
    ];

    const state = averageAt(transactions, '2026-02-10');
    expect(state.quantity.toString()).toBe('250');
    expect(state.totalCost.toString()).toBe('2510');
    expect(state.averageCost.toString()).toBe('10.04');
  });

  it('a same-day buy is inside the average a same-day sale realises against', () => {
    // 2026-01-05: buy 100 @ 10,00  → total 1.000,00, average 10,00
    // 2026-02-10: buy 100 @ 20,00  → total 3.000,00 over 200, average 15,00
    // 2026-02-10: sell 50 @ 30,00  → realized (30,00 − 15,00) × 50 = 750,00
    //
    // If disposals ranked before acquisitions, the sale would realise against
    // 10,00 and report 1.000,00 — and a same-day buy-then-sell of a position
    // opened that morning would be refused outright as "selling more than
    // held".
    const transactions = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-10').quantity('50').price('30.00').build(),
      aTransaction().buy().on('2026-02-10').quantity('100').price('20.00').build(),
    ];

    const state = averageAt(transactions, '2026-02-10');
    expect(state.quantity.toString()).toBe('150');
    expect(state.averageCost.toString()).toBe('15');
    expect(state.realizedGain.toString()).toBe('750');
  });

  it('permits opening and closing a position on the same date', () => {
    // Buy 100 @ 10,00 and sell 100 @ 11,00, both on 2026-02-10.
    // realized = (11,00 − 10,00) × 100 = 100,00, and the lot closes.
    const transactions = [
      aTransaction().sell().on('2026-02-10').quantity('100').price('11.00').build(),
      aTransaction().buy().on('2026-02-10').quantity('100').price('10.00').build(),
    ];

    const state = averageAt(transactions, '2026-02-10');
    expect(state.quantity.toString()).toBe('0');
    expect(state.realizedGain.toString()).toBe('100');
  });
});

describe('SPEC-007 BR-007-16 — only active rows participate', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('AC — an unclassified row is excluded, and classifying it changes the position', () => {
    const active = aTransaction().buy().quantity('100').price('10.00').build();
    const pending = aTransaction()
      .buy()
      .quantity('50')
      .price('20.00')
      .status('unclassified')
      .build();

    // Excluded: 100 @ 10,00 → total 1.000,00, average 10,00
    const before = replayPosition([active, pending]);
    expect(before.ok && before.value.quantity.toString()).toBe('100');
    expect(before.ok && before.value.averageCost.toString()).toBe('10');

    // Classified: total 1.000,00 + 50 × 20,00 = 2.000,00 over 150 shares.
    // 2.000,00 ÷ 150 = 13,333…  → truncated at 8 places: 13,33333333
    const after = replayPosition([active, { ...pending, status: 'active' }]);
    expect(after.ok && after.value.quantity.toString()).toBe('150');
    expect(after.ok && after.value.totalCost.toString()).toBe('2000');
    expect(after.ok && after.value.averageCost.toDecimal().toFixed(8)).toBe('13.33333333');
  });

  it('excludes superseded rows, which a re-import leaves behind', () => {
    const kept = aTransaction().buy().quantity('100').price('10.00').build();
    const replaced = aTransaction()
      .buy()
      .quantity('999')
      .price('99.00')
      .status('superseded')
      .build();

    const result = replayPosition([kept, replaced]);
    expect(result.ok && result.value.quantity.toString()).toBe('100');
  });

  it('replays an empty ledger to an empty position', () => {
    const result = replayPosition([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('0');
    expect(result.value.averageCost.toString()).toBe('0');
  });

  it('surfaces an unreplayable ledger rather than clamping it to zero', () => {
    const result = replayPosition([
      aTransaction().buy().on('2026-01-05').quantity('10').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('50').price('12.00').build(),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(result.error.context).toEqual({ held: '10', requested: '50', date: '2026-02-05' });
  });
});

describe('asOf — BR-007-14, a position at any historical date', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  const transactions = () => [
    aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
    aTransaction().buy().on('2026-06-15').quantity('100').price('20.00').build(),
  ];

  it('includes everything that traded on the asOf date itself', () => {
    // AR-29: these are dates, so there is no intraday cut-off — the position
    // "on 2026-01-05" includes that day's trade.
    const state = averageAt(transactions(), '2026-01-05');
    expect(state.quantity.toString()).toBe('100');
  });

  it('excludes everything after it', () => {
    const state = averageAt(transactions(), '2026-06-14');
    expect(state.quantity.toString()).toBe('100');
    expect(state.averageCost.toString()).toBe('10');
  });

  it('includes the whole ledger when omitted', () => {
    const result = replayPosition(transactions());
    // 1.000,00 + 2.000,00 = 3.000,00 over 200 = 15,00
    expect(result.ok && result.value.averageCost.toString()).toBe('15');
  });

  it('yields an empty position before the first trade', () => {
    const state = averageAt(transactions(), '2025-12-31');
    expect(state.quantity.toString()).toBe('0');
  });
});

describe('BR-007-08 — one position per (asset, institution)', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('keeps the same asset at two institutions apart', () => {
    // Clear:  100 @ 20,00 → average 20,00
    // Rico:   300 @ 40,00 → average 40,00
    // These are two positions, not one blended one — BR-007-08 tracks per
    // institution and only the portfolio view aggregates them.
    const result = replayPositions([
      aTransaction().buy().of('PETR4').at('Clear').quantity('100').price('20.00').build(),
      aTransaction().buy().of('PETR4').at('Rico').quantity('300').price('40.00').build(),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);

    const clear = result.value.find((s) => s.institutionId === institutionIdFor('Clear'));
    const rico = result.value.find((s) => s.institutionId === institutionIdFor('Rico'));
    expect(clear?.state.averageCost.toString()).toBe('20');
    expect(rico?.state.averageCost.toString()).toBe('40');
  });

  it('treats "no institution" as its own bucket, not a wildcard', () => {
    const result = replayPositions([
      aTransaction().buy().of('PETR4').at(null).quantity('100').price('20.00').build(),
      aTransaction().buy().of('PETR4').at('Clear').quantity('100').price('30.00').build(),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.find((s) => s.institutionId === null)?.state.averageCost.toString()).toBe(
      '20',
    );
  });

  it('separates different assets at the same institution', () => {
    const result = replayPositions([
      aTransaction().buy().of('PETR4').at('Clear').quantity('100').price('20.00').build(),
      aTransaction().buy().of('HGLG11').at('Clear').quantity('10').price('160.00').build(),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(
      result.value.find((s) => s.assetId === assetIdFor('HGLG11'))?.state.averageCost.toString(),
    ).toBe('160');
  });

  it('keeps a closed position, because its realized gain still matters', () => {
    // Dropping the row would also make a rebuild and the incremental cache
    // disagree about whether it exists (DM-4).
    const result = replayPositions([
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.state.quantity.toString()).toBe('0');
    expect(result.value[0]?.state.realizedGain.toString()).toBe('200');
  });

  it('emits positions in a deterministic order, so two runs compare byte for byte', () => {
    const rows = [
      aTransaction().buy().of('VALE3').at('Rico').build(),
      aTransaction().buy().of('PETR4').at('Clear').build(),
      aTransaction().buy().of('PETR4').at(null).build(),
      aTransaction().buy().of('PETR4').at('Rico').build(),
    ];

    const first = replayPositions(rows);
    const second = replayPositions([...rows].reverse());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const keys = (r: typeof first.value) => r.map((s) => positionKeyString(s));
    expect(keys(first.value)).toEqual(keys(second.value));
    // Ascending by asset, then institution, with the null institution first.
    expect(keys(first.value)).toEqual([...keys(first.value)].sort());
  });

  it('reports an unreplayable group rather than the positions that happened to work', () => {
    const result = replayPositions([
      aTransaction().buy().of('PETR4').quantity('100').price('10.00').build(),
      aTransaction().sell().of('VALE3').on('2026-02-05').quantity('5').price('60.00').build(),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
  });

  it('replays no positions from an empty ledger', () => {
    const result = replayPositions([]);
    expect(result.ok && result.value).toEqual([]);
  });

  it('honours asOf when grouping', () => {
    const result = replayPositions(
      [
        aTransaction().buy().of('PETR4').on('2026-01-05').build(),
        aTransaction().buy().of('VALE3').on('2026-06-15').build(),
      ],
      { asOf: BusinessDate.of('2026-03-01') },
    );
    expect(result.ok && result.value).toHaveLength(1);
  });
});
