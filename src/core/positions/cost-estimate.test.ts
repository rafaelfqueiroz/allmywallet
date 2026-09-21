import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { asStored, Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { costEstimatedAfter } from '@/core/positions/cost-estimate';
import { EMPTY_POSITION, makePosition } from '@/core/positions/position-state';
import { replayPosition, replayPositionWithEstimate } from '@/core/positions/replay';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — a position whose open
 * lot includes an estimated cost reads as estimated until it closes
 * (BR-007-07).
 */

/** Any open position: the marker rule only asks whether quantity is zero. */
const OPEN = makePosition(Quantity.fromString('10'), Money.fromString('100'), Money.zero());

const estimated = (builder: ReturnType<typeof aTransaction>) =>
  builder.costEstimate('2026-03-10').build();

beforeEach(() => {
  resetTransactionSequence();
});

describe('costEstimatedAfter — which types can mark the open lot', () => {
  const marking: readonly [string, () => Transaction][] = [
    ['buy', () => estimated(aTransaction().buy())],
    ['subscription', () => estimated(aTransaction().subscription())],
    ['transfer_in', () => estimated(aTransaction().transferIn())],
    ['conversion_in', () => estimated(aTransaction().conversionIn('100'))],
    ['bonificacao', () => estimated(aTransaction().bonificacao().price('3.33'))],
    // BR-007-05: an estimated *zero* attributed value is still an estimate.
    ['bonificacao at zero', () => estimated(aTransaction().bonificacao().price('0'))],
    ['positive adjustment', () => estimated(aTransaction().adjustment().quantity('5'))],
  ];

  it.each(marking)('an estimated %s marks it', (_, make) => {
    expect(costEstimatedAfter(false, OPEN, make())).toBe(true);
  });

  it.each(marking)('an exact %s leaves an exact lot exact', (_, make) => {
    const exact = { ...make(), costIsEstimate: false, estimateCloseDate: null };
    expect(costEstimatedAfter(false, OPEN, exact)).toBe(false);
  });

  const nonMarking: readonly [string, () => Transaction][] = [
    ['sell', () => estimated(aTransaction().sell())],
    ['transfer_out', () => estimated(aTransaction().transferOut())],
    ['conversion_out', () => estimated(aTransaction().conversionOut(undefined, '100'))],
    ['negative adjustment', () => estimated(aTransaction().adjustment().quantity('-5'))],
    ['split', () => estimated(aTransaction().split().ratio('2'))],
    ['grupamento', () => estimated(aTransaction().grupamento().ratio('0.5'))],
    ['fracao_bonificacao', () => estimated(aTransaction().fracaoBonificacao().quantity('0.5'))],
    ['dividend', () => estimated(aTransaction().dividend())],
    ['jcp', () => estimated(aTransaction().jcp())],
    ['rendimento', () => estimated(aTransaction().rendimento())],
    ['amortization', () => estimated(aTransaction().amortization())],
    ['leilao_fracoes', () => estimated(aTransaction().leilaoFracoes())],
  ];

  // A disposal removes shares at the average (BR-007-03, BR-007-05b), a ratio
  // event keeps total cost (BR-007-04), a fraction leaves at unchanged total
  // cost (BR-007-05a) and a provento never touches the position — none of them
  // puts a figure into the lot's cost.
  it.each(nonMarking)('an estimated %s does not mark an exact lot', (_, make) => {
    expect(costEstimatedAfter(false, OPEN, make())).toBe(false);
  });

  it.each(nonMarking)('an exact %s does not clear an estimated lot', (_, make) => {
    const exact = { ...make(), costIsEstimate: false, estimateCloseDate: null };
    expect(costEstimatedAfter(true, OPEN, exact)).toBe(true);
  });

  it('BR-007-07: reaching zero resets the marker, whatever the transaction', () => {
    const sale = aTransaction().sell().build();
    expect(costEstimatedAfter(true, EMPTY_POSITION, sale)).toBe(false);
    // Even an estimated acquisition cannot leave a zero position marked.
    const buy = estimated(aTransaction().buy());
    expect(costEstimatedAfter(true, EMPTY_POSITION, buy)).toBe(false);
  });
});

describe('BR-007-06 — the marker through a sequence (TS-06)', () => {
  /**
   * One continuous history, the marker and the figures checked at every step.
   *
   *  1. 2026-01-05  buy 100 @ 10,00
   *       qty 100, total 1.000,00, average 10,00                  → exact
   *  2. 2026-03-10  subscription 20 @ 114,90, estimated (close 2026-03-10)
   *       total 1.000,00 + 20 × 114,90 = 1.000,00 + 2.298,00 = 3.298,00
   *       qty 120, average 3.298,00 ÷ 120 = 27,48333…             → estimated
   *  3. 2026-04-01  split ×2 (BR-007-04: total unchanged)
   *       qty 240, total 3.298,00, average 3.298,00 ÷ 240 = 13,741666…
   *                                                               → estimated
   *  4. 2026-05-04  sell 40 @ 15,00 (BR-007-03: average unchanged)
   *       qty 200, average 13,741666…
   *       total 3.298,00 − 40 × 13,741666… = 3.298,00 − 549,666… = 2.748,333…
   *                                          → still estimated: the average
   *                                            the 200 are held at is the
   *                                            estimated one
   *  5. 2026-06-01  sell 200 @ 16,00 → qty 0, reset (BR-007-07)   → exact
   *  6. 2026-07-01  buy 10 @ 12,00 → a new lot, 120,00, avg 12,00 → exact
   *
   * Repeating averages are asserted at the column's eight places (`asStored`,
   * half-up as Postgres casts): 27,48333333 and 13,74166667.
   */
  const history = () => [
    aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
    aTransaction()
      .subscription()
      .on('2026-03-10')
      .quantity('20')
      .price('114.90')
      .costEstimate('2026-03-10')
      .build(),
    aTransaction().split().on('2026-04-01').ratio('2').build(),
    aTransaction().sell().on('2026-05-04').quantity('40').price('15.00').build(),
    aTransaction().sell().on('2026-06-01').quantity('200').price('16.00').build(),
    aTransaction().buy().on('2026-07-01').quantity('10').price('12.00').build(),
  ];

  function at(date: string) {
    const result = replayPositionWithEstimate(history(), { asOf: BusinessDate.of(date) });
    if (!result.ok) throw new Error(`replay failed at ${date}: ${result.error.code}`);
    return result.value;
  }

  it('1. an exact buy is exact', () => {
    const step = at('2026-01-05');
    expect(step.state.averageCost.toString()).toBe('10');
    expect(step.costEstimated).toBe(false);
  });

  it('2. an estimated subscription marks the position', () => {
    const step = at('2026-03-10');
    expect(step.state.quantity.toString()).toBe('120');
    expect(step.state.totalCost.toString()).toBe('3298');
    expect(asStored(step.state.averageCost)).toBe('27.48333333');
    expect(step.costEstimated).toBe(true);
  });

  it('3. a split keeps it', () => {
    const step = at('2026-04-01');
    expect(step.state.quantity.toString()).toBe('240');
    expect(step.state.totalCost.toString()).toBe('3298');
    expect(asStored(step.state.averageCost)).toBe('13.74166667');
    expect(step.costEstimated).toBe(true);
  });

  it('4. a partial sale keeps it', () => {
    const step = at('2026-05-04');
    expect(step.state.quantity.toString()).toBe('200');
    expect(asStored(step.state.averageCost)).toBe('13.74166667');
    expect(asStored(step.state.totalCost)).toBe('2748.33333333');
    expect(step.costEstimated).toBe(true);
  });

  it('5. a full close resets it (BR-007-07)', () => {
    const step = at('2026-06-01');
    expect(step.state.quantity.isZero()).toBe(true);
    expect(step.costEstimated).toBe(false);
  });

  it('6. reopening with an exact buy is not marked', () => {
    const step = at('2026-07-01');
    expect(step.state.quantity.toString()).toBe('10');
    expect(step.state.averageCost.toString()).toBe('12');
    expect(step.costEstimated).toBe(false);
  });

  it('agrees with replayPosition on every figure', () => {
    const marked = replayPositionWithEstimate(history());
    const plain = replayPosition(history());
    expect(marked.ok && plain.ok).toBe(true);
    if (!marked.ok || !plain.ok) return;
    expect(marked.value.state).toEqual(plain.value);
  });

  it('fails where replayPosition fails, naming the same error', () => {
    const unreplayable = [aTransaction().sell().on('2026-01-05').quantity('1').build()];
    const marked = replayPositionWithEstimate(unreplayable);
    expect(marked.ok).toBe(false);
    if (marked.ok) return;
    expect(marked.error.code).toBe('INSUFFICIENT_QUANTITY');
  });
});

describe('BR-007-06 / BR-007-15 — a backdated estimate (TS-07)', () => {
  it('an estimated subscription backdated into an open lot marks it', () => {
    //  2026-01-05  buy 100 @ 10,00
    //  2026-02-01  subscription 20 @ 114,90, estimated — entered last
    //  2026-03-01  sell 50 @ 30,00
    //  Replay order puts the subscription before the sale: 120 held at
    //  3.298,00 when 50 leave, 70 remain at the estimated average → marked.
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-03-01').quantity('50').price('30.00').build(),
      aTransaction()
        .subscription()
        .on('2026-02-01')
        .quantity('20')
        .price('114.90')
        .costEstimate('2026-02-01')
        .build(),
    ];
    const result = replayPositionWithEstimate(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.quantity.toString()).toBe('70');
    expect(result.value.costEstimated).toBe(true);
  });

  it('an estimated subscription backdated into a lot that later closed marks nothing', () => {
    //  2026-01-05  buy 100 @ 10,00
    //  2026-02-01  subscription 20, estimated — entered last
    //  2026-03-01  sell 120 → closed (BR-007-07)
    //  2026-04-01  buy 10 @ 12,00 → a new, exact lot
    // Appending the subscription instead of replaying would mark the new lot.
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-03-01').quantity('120').price('30.00').build(),
      aTransaction().buy().on('2026-04-01').quantity('10').price('12.00').build(),
      aTransaction()
        .subscription()
        .on('2026-02-01')
        .quantity('20')
        .price('114.90')
        .costEstimate('2026-02-01')
        .build(),
    ];
    const result = replayPositionWithEstimate(rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.averageCost.toString()).toBe('12');
    expect(result.value.costEstimated).toBe(false);
  });

  it('an unclassified estimated row marks nothing (BR-007-16: it never replays)', () => {
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction()
        .subscription()
        .on('2026-02-01')
        .quantity('20')
        .price('114.90')
        .costEstimate('2026-02-01')
        .status('unclassified')
        .build(),
    ];
    const result = replayPositionWithEstimate(rows);
    expect(result.ok && result.value.costEstimated).toBe(false);
  });
});
