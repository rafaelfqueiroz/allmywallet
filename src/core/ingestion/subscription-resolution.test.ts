import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import {
  resolveSubscriptions,
  type ResolvedSubscriptionPair,
  type SubscriptionEvidence,
} from '@/core/ingestion/subscription-resolution';

/**
 * SPEC-005 BR-005-20d (#144) — the subscription resolver, on generated
 * fixtures (DV-24) shaped after the four real cases: an FII right/receipt/
 * credit (XXXX12 → XXXX11) and a stock right/receipt/credit (YYYY2 → YYYY4).
 * Quantities and dates are invented.
 */

function exercise(
  id: string,
  code: string,
  quantity: string,
  tradeDate: string,
  overrides: Partial<SubscriptionEvidence> = {},
): SubscriptionEvidence {
  return {
    id,
    role: 'exercise',
    assetCode: code,
    tradeDate: BusinessDate.of(tradeDate),
    quantity: Quantity.fromString(quantity),
    state: 'open',
    ...overrides,
  };
}

function credit(
  id: string,
  code: string,
  quantity: string,
  tradeDate: string,
  overrides: Partial<SubscriptionEvidence> = {},
): SubscriptionEvidence {
  return {
    id,
    role: 'credit',
    assetCode: code,
    tradeDate: BusinessDate.of(tradeDate),
    quantity: Quantity.fromString(quantity),
    state: 'open',
    balanceBefore: null,
    ...overrides,
  };
}

const resolve = (evidence: readonly SubscriptionEvidence[], windowDays = 120) =>
  resolveSubscriptions({ evidence, windowDays });

describe('SPEC-005 BR-005-20d (#144) — an exercised subscription paired with its Atualização credit', () => {
  it('pairs a same-issuer, same-quantity exercise and credit within the window as one resolved subscription', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX11', '3', '2024-02-22'),
    ]);

    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs as [ResolvedSubscriptionPair];
    expect(pair.status).toBe('resolved');
    expect(pair.plan).toEqual({
      exerciseId: 'ex',
      creditId: 'cr',
      assetCode: 'XXXX11',
      tradeDate: BusinessDate.of('2024-02-22'),
      quantity: Quantity.fromString('3'),
    });
    expect(result.unresolved.size).toBe(0);
  });

  it('pairs a stock right/receipt exercise with its main-code credit 78 days later', () => {
    const result = resolve([
      exercise('ex', 'YYYY2', '78', '2024-01-01'),
      credit('cr', 'YYYY4', '78', '2024-03-19'), // +78 days
    ]);

    expect(result.pairs).toEqual([
      {
        status: 'resolved',
        plan: {
          exerciseId: 'ex',
          creditId: 'cr',
          assetCode: 'YYYY4',
          tradeDate: BusinessDate.of('2024-03-19'),
          quantity: Quantity.fromString('78'),
        },
      },
    ]);
  });

  it('reports both rows already applied when a re-import finds them written', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22', { state: 'applied' }),
      credit('cr', 'XXXX11', '3', '2024-02-22', { state: 'applied' }),
    ]);

    expect(result.pairs).toEqual([{ status: 'applied', exerciseId: 'ex', creditId: 'cr' }]);
  });

  it('reports applied when only the exercise side reflects it (never repriced, D7)', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22', { state: 'applied' }),
      credit('cr', 'XXXX11', '3', '2024-02-22'),
    ]);

    expect(result.pairs).toEqual([{ status: 'applied', exerciseId: 'ex', creditId: 'cr' }]);
  });

  it('leaves an exercise with no same-issuer, same-quantity credit unresolved with no diagnostic', () => {
    const result = resolve([exercise('ex', 'XXXX12', '3', '2024-01-22')]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.size).toBe(0);
  });

  it('never pairs an exercise with a credit on its own ticker', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX12', '3', '2024-02-22'),
    ]);

    expect(result.pairs).toHaveLength(0);
  });

  it('refuses outside_window when the only same-shape credit falls after the configured window', () => {
    const result = resolve(
      [exercise('ex', 'XXXX12', '3', '2024-01-01'), credit('cr', 'XXXX11', '3', '2024-06-01')],
      120,
    );

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('ex')).toBe('outside_window');
    expect(result.unresolved.get('cr')).toBe('outside_window');
  });

  it('refuses outside_window when the same-shape credit falls before the exercise', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-02-22'),
      credit('cr', 'XXXX11', '3', '2024-01-22'),
    ]);

    expect(result.unresolved.get('ex')).toBe('outside_window');
  });

  it('accepts a credit exactly at the window boundary', () => {
    const result = resolve(
      [exercise('ex', 'XXXX12', '10', '2024-01-01'), credit('cr', 'XXXX11', '10', '2024-04-30')], // exactly 120 days
      120,
    );

    expect(result.pairs).toHaveLength(1);
  });

  it('refuses a credit one day past the window boundary', () => {
    const result = resolve(
      [exercise('ex', 'XXXX12', '10', '2024-01-01'), credit('cr', 'XXXX11', '10', '2024-05-01')], // 121 days
      120,
    );

    expect(result.unresolved.get('ex')).toBe('outside_window');
  });

  it('accepts a same-day exercise and credit (zero-day window)', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '5', '2024-01-01'),
      credit('cr', 'XXXX11', '5', '2024-01-01'),
    ]);

    expect(result.pairs).toHaveLength(1);
  });

  it('refuses ambiguous when two credits of the same quantity are both within the window', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-01'),
      credit('cr-a', 'XXXX11', '3', '2024-01-10'),
      credit('cr-b', 'XXXX13', '3', '2024-01-20'),
    ]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('ex')).toBe('ambiguous');
    expect(result.unresolved.get('cr-a')).toBe('ambiguous');
    expect(result.unresolved.get('cr-b')).toBe('ambiguous');
  });

  it('refuses ambiguous when two exercises could both claim the one matching credit', () => {
    const result = resolve([
      exercise('ex-a', 'XXXX12', '3', '2024-01-01'),
      exercise('ex-b', 'XXXX13', '3', '2024-01-05'),
      credit('cr', 'XXXX11', '3', '2024-01-20'),
    ]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('ex-a')).toBe('ambiguous');
    expect(result.unresolved.get('ex-b')).toBe('ambiguous');
    expect(result.unresolved.get('cr')).toBe('ambiguous');
  });

  it('an unrelated pair elsewhere in the evidence set still resolves alongside an ambiguous one', () => {
    const result = resolve([
      exercise('ex-a', 'XXXX12', '3', '2024-01-01'),
      exercise('ex-b', 'XXXX13', '3', '2024-01-05'),
      credit('cr', 'XXXX11', '3', '2024-01-20'),
      exercise('ex-c', 'ZZZZ2', '9', '2024-01-01'),
      credit('cr-c', 'ZZZZ4', '9', '2024-02-01'),
    ]);

    expect(result.pairs).toEqual([
      {
        status: 'resolved',
        plan: {
          exerciseId: 'ex-c',
          creditId: 'cr-c',
          assetCode: 'ZZZZ4',
          tradeDate: BusinessDate.of('2024-02-01'),
          quantity: Quantity.fromString('9'),
        },
      },
    ]);
    expect(result.unresolved.get('ex-a')).toBe('ambiguous');
  });

  it('refuses user_modified when the exercise is locked (hand-classified or edited)', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22', { state: 'locked' }),
      credit('cr', 'XXXX11', '3', '2024-02-22'),
    ]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('ex')).toBe('user_modified');
    expect(result.unresolved.get('cr')).toBe('user_modified');
  });

  it('refuses user_modified when the credit is locked', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX11', '3', '2024-02-22', { state: 'locked' }),
    ]);

    expect(result.unresolved.get('ex')).toBe('user_modified');
  });

  it('refuses balance_statement when the credited quantity equals the balance the position already held (D8)', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX11', '3', '2024-02-22', { balanceBefore: Quantity.fromString('3') }),
    ]);

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('cr')).toBe('balance_statement');
  });

  it('pairs normally when the balance before differs from the credited quantity', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX11', '3', '2024-02-22', { balanceBefore: Quantity.fromString('49') }),
    ]);

    expect(result.pairs).toHaveLength(1);
  });

  it('pairs normally when the balance before does not replay at all (null)', () => {
    const result = resolve([
      exercise('ex', 'XXXX12', '3', '2024-01-22'),
      credit('cr', 'XXXX11', '3', '2024-02-22', { balanceBefore: null }),
    ]);

    expect(result.pairs).toHaveLength(1);
  });

  it('refuses every row outside_window when windowDays is negative (an invalid config value)', () => {
    const result = resolve(
      [exercise('ex', 'XXXX12', '3', '2024-01-22'), credit('cr', 'XXXX11', '3', '2024-02-22')],
      -1,
    );

    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.get('ex')).toBe('outside_window');
    expect(result.unresolved.get('cr')).toBe('outside_window');
  });

  it('refuses every row outside_window when windowDays is not an integer', () => {
    const result = resolve(
      [exercise('ex', 'XXXX12', '3', '2024-01-22'), credit('cr', 'XXXX11', '3', '2024-02-22')],
      1.5,
    );

    expect(result.unresolved.get('ex')).toBe('outside_window');
  });

  it('resolves nothing and reports nothing on empty evidence', () => {
    const result = resolve([]);
    expect(result.pairs).toHaveLength(0);
    expect(result.unresolved.size).toBe(0);
  });
});
