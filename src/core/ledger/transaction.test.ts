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

describe('SPEC-006 BR-006-05 — the seventeen supported types', () => {
  it('names exactly the seventeen the spec lists', () => {
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
      'leilao_fracoes',
      'fracao_bonificacao',
      'conversion_out',
      'conversion_in',
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
      'leilao_fracoes',
    ]);
    // SPEC-007 BR-007-05a / SPEC-014 BR-014-01: the fraction moves the
    // position; its auction cash is income.
    expect(affectsPosition('fracao_bonificacao')).toBe(true);
    expect(isEarnings('leilao_fracoes')).toBe(true);
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

  it('BR-007-05a — is zero for a bonificação fraction, whatever price and fees it carries', () => {
    // A hand-entered removal of 0,2 at 14,00 with 1,00 of fees would otherwise
    // store 0,2 × 14,00 + 1,00 = 3,80 and read as income beside its leilão,
    // whose 0,2 × 14,00 = 2,80 is the only cash the fraction produced.
    const fraction = Quantity.fromString('0.2');
    expect(
      computeTotalValue(
        'fracao_bonificacao',
        fraction,
        Money.fromString('14.00'),
        Money.fromString('1.00'),
      ).toString(),
    ).toBe('0');
    // The leilão row keeps its cash: 0,2 × 14,00 = 2,80.
    expect(
      computeTotalValue(
        'leilao_fracoes',
        fraction,
        Money.fromString('14.00'),
        Money.zero(),
      ).toString(),
    ).toBe('2.8');
  });

  it('BR-006-05 / BR-007-05b — is zero for both conversion legs', () => {
    expect(computeTotalValue('conversion_out', quantity, price, fees).toString()).toBe('0');
    expect(computeTotalValue('conversion_in', quantity, price, fees).toString()).toBe('0');
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
