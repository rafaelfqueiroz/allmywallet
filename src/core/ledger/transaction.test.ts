import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  affectsPosition,
  computeTotalValue,
  isActive,
  isEarnings,
  requiresRatio,
} from '@/core/ledger/transaction';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';

describe('SPEC-006 BR-006-05 — the thirteen supported types', () => {
  it('names exactly the thirteen the spec lists, in the spec’s order', () => {
    expect([...TRANSACTION_TYPES]).toEqual([
      'buy',
      'sell',
      'dividend',
      'jcp',
      'rendimento',
      'amortization',
      'split',
      'grupamento',
      'bonificacao',
      'subscription',
      'transfer_in',
      'transfer_out',
      'adjustment',
    ]);
  });

  it('BR-006-03 — three statuses, of which only one is calculated on', () => {
    expect([...TRANSACTION_STATUSES]).toEqual(['active', 'unclassified', 'superseded']);
    expect(isActive(aTransaction().build())).toBe(true);
    expect(isActive(aTransaction().status('unclassified').build())).toBe(false);
    expect(isActive(aTransaction().status('superseded').build())).toBe(false);
  });

  it('classifies each type as position-affecting or a provento, and never both', () => {
    for (const type of TRANSACTION_TYPES) {
      expect(affectsPosition(type) !== isEarnings(type)).toBe(true);
    }
    expect(TRANSACTION_TYPES.filter(isEarnings)).toEqual([
      'dividend',
      'jcp',
      'rendimento',
      'amortization',
    ]);
  });

  it('requires a ratio for exactly the two share-base ratio events', () => {
    expect(TRANSACTION_TYPES.filter(requiresRatio)).toEqual(['split', 'grupamento']);
  });
});

describe('computeTotalValue', () => {
  const quantity = Quantity.fromString('100');
  const price = Money.fromString('32.15');
  const fees = Money.fromString('4.90');

  it('adds fees on an acquisition', () => {
    // 100 × 32,15 = 3.215,00, plus 4,90 = 3.219,90
    expect(computeTotalValue('buy', quantity, price, fees).toString()).toBe('3219.9');
    expect(computeTotalValue('subscription', quantity, price, fees).toString()).toBe('3219.9');
    expect(computeTotalValue('transfer_in', quantity, price, fees).toString()).toBe('3219.9');
  });

  it('subtracts fees on a disposal — the cash that actually arrives', () => {
    // 3.215,00 − 4,90 = 3.210,10
    expect(computeTotalValue('sell', quantity, price, fees).toString()).toBe('3210.1');
    expect(computeTotalValue('transfer_out', quantity, price, fees).toString()).toBe('3210.1');
  });

  it('is zero for a bonificação with nothing attributed', () => {
    expect(computeTotalValue('bonificacao', quantity, Money.zero(), Money.zero()).toString()).toBe(
      '0',
    );
  });

  it('values a provento at quantity × per-share amount', () => {
    // 100 shares × 0,75 per share = 75,00
    expect(
      computeTotalValue('dividend', quantity, Money.fromString('0.75'), Money.zero()).toString(),
    ).toBe('75');
  });

  it('stays a plain decimal string, never a float (AR-06)', () => {
    // 3 × 0,1 is 0,30000000000000004 in IEEE-754.
    const value = computeTotalValue(
      'buy',
      Quantity.fromString('3'),
      Money.fromString('0.1'),
      Money.zero(),
    );
    expect(value.toString()).toBe('0.3');
  });
});
