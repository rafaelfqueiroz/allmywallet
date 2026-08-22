import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import type { AllocationEvent, EarningRecord } from '@/core/reporting/ports';
import {
  allocationAt,
  attributeAll,
  attributeEarning,
} from '@/core/reporting/earnings/attribution';
import { assetIdOf, day, institutionIdOf, walletIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-014 BR-014-12 / DL-014-05 — the rule this module exists for:
 * **reallocating a holding today must not change last year's income.**
 *
 * Every test below is a statement about *when*, not about arithmetic. The
 * arithmetic is `distributeExact`'s and is proven in `base-query.test.ts`.
 */

const PETR = assetIdOf('1');
const ITSA = assetIdOf('2');
const RETIREMENT = walletIdOf('1');
const RESERVE = walletIdOf('2');

const event = (
  walletId: ReturnType<typeof walletIdOf>,
  assetId: ReturnType<typeof assetIdOf>,
  quantity: string,
  effectiveOn: string,
): AllocationEvent => ({
  walletId,
  assetId,
  quantity: Quantity.fromString(quantity),
  effectiveOn: day(effectiveOn),
});

const earning = (
  assetId: ReturnType<typeof assetIdOf>,
  amount: string,
  payDate: string,
  quantity = '100',
): EarningRecord => ({
  assetId,
  institutionId: institutionIdOf('1'),
  type: 'dividend',
  payDate: day(payDate),
  amount: Money.fromString(amount),
  quantity: Quantity.fromString(quantity),
});

describe('allocationAt — the log folds to a state', () => {
  it('takes the latest event at or before the date, per wallet and asset', () => {
    const state = allocationAt(
      [event(RETIREMENT, PETR, '100', '2024-01-10'), event(RETIREMENT, PETR, '150', '2025-06-01')],
      day('2024-12-31'),
    );

    expect(state.get(PETR)?.get(RETIREMENT)?.toString()).toBe('100');
  });

  it('ignores everything after the date — the future cannot change the past', () => {
    const state = allocationAt([event(RETIREMENT, PETR, '100', '2026-01-10')], day('2025-12-31'));
    expect(state.size).toBe(0);
  });

  /**
   * The zero is kept rather than dropped. "Holds none from this date" is a
   * state; an absence is indistinguishable from never having held any, and
   * would leave the previous quantity standing for every later date.
   */
  it('records a zero-quantity event as a state, not as an absence', () => {
    const state = allocationAt(
      [event(RETIREMENT, PETR, '100', '2024-01-10'), event(RETIREMENT, PETR, '0', '2024-08-01')],
      day('2024-12-31'),
    );

    expect(state.get(PETR)?.get(RETIREMENT)?.toString()).toBe('0');
  });

  it('leaves the wallets that still hold something untouched when one empties', () => {
    const state = allocationAt(
      [
        event(RETIREMENT, PETR, '60', '2024-01-10'),
        event(RESERVE, PETR, '40', '2024-01-10'),
        event(RESERVE, PETR, '0', '2024-08-01'),
      ],
      day('2024-12-31'),
    );

    expect(state.get(PETR)?.get(RETIREMENT)?.toString()).toBe('60');
    expect(state.get(PETR)?.get(RESERVE)?.toString()).toBe('0');
  });

  it('keeps assets apart', () => {
    const state = allocationAt(
      [event(RETIREMENT, PETR, '60', '2024-01-10'), event(RETIREMENT, ITSA, '40', '2024-01-10')],
      day('2024-12-31'),
    );

    expect(state.get(PETR)?.get(RETIREMENT)?.toString()).toBe('60');
    expect(state.get(ITSA)?.get(RETIREMENT)?.toString()).toBe('40');
  });
});

describe('attributeEarning — one payment, split as the wallets stood', () => {
  it('sends the whole payment to Unassigned when no wallet had claimed it', () => {
    const result = attributeEarning(earning(PETR, '120', '2025-03-10'), new Map());
    expect(result).toHaveLength(1);
    expect(result[0]?.walletId).toBeNull();
    expect(result[0]?.amount.toString()).toBe('120');
  });

  it('splits pro rata and leaves the unclaimed share in Unassigned (BR-011-09)', () => {
    const state = allocationAt([event(RETIREMENT, PETR, '60', '2024-01-01')], day('2025-03-10'));
    const result = attributeEarning(earning(PETR, '100', '2025-03-10', '100'), state);
    expect(result.map((slice) => [slice.walletId, slice.amount.toString()])).toEqual([
      [RETIREMENT, '60'],
      [null, '40'],
    ]);
  });

  it('emits no Unassigned slice when the position is fully allocated', () => {
    const state = allocationAt([event(RETIREMENT, PETR, '100', '2024-01-01')], day('2025-03-10'));
    const result = attributeEarning(earning(PETR, '100', '2025-03-10', '100'), state);
    expect(result).toHaveLength(1);
    expect(result[0]?.walletId).toBe(RETIREMENT);
  });

  /**
   * A hand-entered provento may name no quantity (SPEC-006 permits it). There
   * is then no held quantity to compare the allocations against, so they are
   * all there is to go on — stated here rather than silently becoming "fully
   * unassigned", which would move a wallet's income out of it.
   */
  it('splits over the allocations alone when the row states no quantity', () => {
    const state = allocationAt(
      [event(RETIREMENT, PETR, '60', '2024-01-01'), event(RESERVE, PETR, '40', '2024-01-01')],
      day('2025-03-10'),
    );
    const result = attributeEarning(earning(PETR, '100', '2025-03-10', '0'), state);
    expect(result.map((slice) => slice.amount.toString())).toEqual(['60', '40']);
  });

  /**
   * A stale allocation for a position since reduced — `reconcile-allocations`
   * repairs it when it next runs, and until then the split must still sum to
   * the payment. A negative remainder would make one wallet's income exceed
   * the portfolio's.
   */
  it('clamps the remainder when allocations exceed the quantity paid on', () => {
    const state = allocationAt([event(RETIREMENT, PETR, '150', '2024-01-01')], day('2025-03-10'));
    const result = attributeEarning(earning(PETR, '100', '2025-03-10', '100'), state);
    expect(result).toHaveLength(1);
    expect(result[0]?.amount.toString()).toBe('100');
  });

  // TS-11: the split is exact, including where the division does not terminate.
  it('loses nothing to a three-way split of an awkward amount', () => {
    const state = allocationAt(
      [
        event(RETIREMENT, PETR, '1', '2024-01-01'),
        event(RESERVE, PETR, '1', '2024-01-01'),
        event(walletIdOf('3'), PETR, '1', '2024-01-01'),
      ],
      day('2025-03-10'),
    );
    const result = attributeEarning(earning(PETR, '100', '2025-03-10', '3'), state);
    const summed = result.reduce((acc, slice) => acc.plus(slice.amount), Money.zero());
    expect(summed.toString()).toBe('100');
  });
});

describe('attributeAll — the rule, end to end', () => {
  /**
   * **The test this module exists for.** A holding sits in Reserva until June
   * and in Aposentadoria afterwards. April's income is Reserva's for ever;
   * August's is Aposentadoria's. Nothing about the reassignment reaches back.
   */
  it('attributes each payment to the wallet that held it on that pay date', () => {
    const events = [
      event(RESERVE, PETR, '100', '2025-01-01'),
      event(RESERVE, PETR, '0', '2025-06-15'),
      event(RETIREMENT, PETR, '100', '2025-06-15'),
    ];

    const result = attributeAll(
      [earning(PETR, '80', '2025-04-10'), earning(PETR, '90', '2025-08-10')],
      events,
    );
    expect(
      result.map((slice) => [slice.earning.payDate, slice.walletId, slice.amount.toString()]),
    ).toEqual([
      ['2025-04-10', RESERVE, '80'],
      ['2025-08-10', RETIREMENT, '90'],
    ]);
  });

  it('reuses one fold per pay date rather than per payment', () => {
    const events = [event(RESERVE, PETR, '100', '2025-01-01')];
    const result = attributeAll(
      [earning(PETR, '10', '2025-04-10'), earning(ITSA, '20', '2025-04-10')],
      events,
    );

    // ITSA has no allocation, so it lands in Unassigned — proving the memoised
    // snapshot is per date and not per asset.
    expect(result.map((slice) => slice.walletId)).toEqual([RESERVE, null]);
  });

  /**
   * A position sold out of a wallet before the payment landed. The fold drops
   * the emptied allocation, so there is nothing left to attribute to and the
   * income is Unassigned — which is the honest answer, and importantly not an
   * error: the payment is real and must still reach the total.
   */
  it('reports income on an emptied allocation as unassigned, not as a failure', () => {
    const events = [
      event(RESERVE, PETR, '100', '2025-01-01'),
      event(RESERVE, PETR, '0', '2025-02-01'),
    ];
    const result = attributeAll([earning(PETR, '10', '2025-04-10')], events);

    expect(result).toEqual([expect.objectContaining({ walletId: null })]);
    expect(result[0]?.amount.toString()).toBe('10');
  });

  /**
   * **A payment is never lost.** Every wallet holds zero *and* the row states
   * no quantity — a hand-entered provento on an asset whose allocations were
   * emptied before the pay date. There is nothing to apportion by at all, so
   * the income goes to Unassigned rather than the report failing over one row.
   */
  it('keeps a payment that cannot be apportioned at all, as unassigned', () => {
    const events = [
      event(RESERVE, PETR, '100', '2025-01-01'),
      event(RESERVE, PETR, '0', '2025-02-01'),
    ];
    const result = attributeAll([earning(PETR, '10', '2025-04-10', '0')], events);

    expect(result).toHaveLength(1);
    expect(result[0]?.walletId).toBeNull();
    expect(result[0]?.amount.toString()).toBe('10');
  });

  it('gives a wallet holding zero no slice at all, rather than an empty one', () => {
    const events = [
      event(RESERVE, PETR, '100', '2025-01-01'),
      event(RETIREMENT, PETR, '0', '2025-01-01'),
    ];
    const result = attributeAll([earning(PETR, '50', '2025-04-10', '100')], events);

    expect(result.map((slice) => slice.walletId)).toEqual([RESERVE]);
  });
});
