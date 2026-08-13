import { beforeEach, describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import type { TransactionType } from '@/core/ledger/transaction';
import {
  aTransaction,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { applyTransaction } from '@/core/positions/apply-transaction';
import { applyAcquisition } from '@/core/positions/average-cost';
import { EMPTY_POSITION, type PositionState } from '@/core/positions/position-state';

/** 100 shares at 10,00 — total cost 1.000,00. */
const HOLDING: PositionState = applyAcquisition(EMPTY_POSITION, {
  quantity: Quantity.fromString('100'),
  unitPrice: Money.fromString('10.00'),
  fees: Money.zero(),
});

describe('applyTransaction — the type → effect dispatch', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('BR-007-02 — a buy acquires at price plus fees', () => {
    // 1.000,00 + 50 × 14,00 + 6,00 = 1.000,00 + 700,00 + 6,00 = 1.706,00
    // over 150 shares. Hand-check: 1.706,00 ÷ 150 = 11,37333… so assert the
    // additive figures exactly and the average to eight places by truncation:
    // 150 × 11,37333333 = 1.705,99999950, remainder within the 9th place.
    const result = applyTransaction(
      HOLDING,
      aTransaction().buy().quantity('50').price('14.00').fees('6.00').build(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('150');
    expect(result.value.totalCost.toString()).toBe('1706');
    expect(result.value.averageCost.toDecimal().toFixed(8)).toBe('11.37333333');
  });

  it('BR-007-06 — a subscription is a buy at the subscription price', () => {
    // 1.000,00 + 100 × 6,00 = 1.600,00 over 200 = 8,00
    const result = applyTransaction(
      HOLDING,
      aTransaction().subscription().quantity('100').price('6.00').build(),
    );
    expect(result.ok && result.value.averageCost.toString()).toBe('8');
  });

  it('a transfer_in opens the destination lot at the cost the source recorded', () => {
    // Shares arriving from another custodian carry their cost on unit_price.
    // 1.000,00 + 40 × 7,50 = 1.000,00 + 300,00 = 1.300,00 over 140 shares.
    // 1.300,00 ÷ 140 = 9,285714285714…  → truncated at 8 places: 9,28571428
    const result = applyTransaction(
      HOLDING,
      aTransaction().transferIn().quantity('40').price('7.50').build(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('140');
    expect(result.value.totalCost.toString()).toBe('1300');
    expect(result.value.averageCost.toDecimal().toFixed(8)).toBe('9.28571428');
  });

  it('a transfer_out removes at average cost and realises nothing', () => {
    // A custody move is not a disposal. Realising a gain here would put a
    // figure in the user's realized total that no broker ever reported.
    // 1.000,00 − 10,00 × 40 = 600,00 over 60 shares, average still 10,00.
    const result = applyTransaction(
      HOLDING,
      aTransaction().transferOut().quantity('40').price('99.00').build(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('60');
    expect(result.value.totalCost.toString()).toBe('600');
    expect(result.value.averageCost.toString()).toBe('10');
    // Note the 99,00 "price" on the row is ignored on purpose.
    expect(result.value.realizedGain.toString()).toBe('0');
  });

  it('BR-007-05 — a bonificação adds shares at the attributed value', () => {
    // 1.000,00 + 25 × 0,00 = 1.000,00 over 125 shares = 8,00
    const result = applyTransaction(
      HOLDING,
      aTransaction().bonificacao().quantity('25').price('0').build(),
    );
    expect(result.ok && result.value.averageCost.toString()).toBe('8');
  });

  describe('BR-007-04 — split and grupamento', () => {
    it('applies the ratio for a split', () => {
      const result = applyTransaction(HOLDING, aTransaction().split().ratio('2').build());
      expect(result.ok && result.value.quantity.toString()).toBe('200');
      expect(result.ok && result.value.averageCost.toString()).toBe('5');
    });

    it('applies the ratio for a grupamento', () => {
      const result = applyTransaction(HOLDING, aTransaction().grupamento().ratio('0.1').build());
      expect(result.ok && result.value.quantity.toString()).toBe('10');
      expect(result.ok && result.value.averageCost.toString()).toBe('100');
    });

    it.each(['split', 'grupamento'] as const)(
      'refuses a %s row that carries no ratio — the event would silently vanish',
      (type) => {
        // The database CHECK makes this unreachable through the normal write
        // path, but a replay that met one must fail loudly rather than treat a
        // 1:2 split as a no-op and understate every later average by half.
        const row = { ...aTransaction().split().ratio('2').build(), type, ratio: null };
        const result = applyTransaction(HOLDING, row);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('MISSING_EVENT_RATIO');
        expect(result.error.context['date']).toBe('2026-01-05');
      },
    );

    it('propagates an invalid ratio from the ratio handler', () => {
      const row = { ...aTransaction().split().ratio('2').build(), ratio: Quantity.zero() };
      const result = applyTransaction(HOLDING, row);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_EVENT_RATIO');
    });
  });

  describe('BR-007-03/09 — sell', () => {
    it('reduces quantity, keeps the average and realises the gain', () => {
      // (18,00 − 10,00) × 40 − 2,00 = 8,00 × 40 − 2,00 = 320,00 − 2,00 = 318,00
      const result = applyTransaction(
        HOLDING,
        aTransaction().sell().quantity('40').price('18.00').fees('2.00').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('60');
      expect(result.value.averageCost.toString()).toBe('10');
      expect(result.value.realizedGain.toString()).toBe('318');
    });

    it('refuses to oversell', () => {
      const result = applyTransaction(
        HOLDING,
        aTransaction().sell().quantity('101').price('18.00').build(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    });
  });

  describe('adjustment — the one type whose quantity is signed', () => {
    it('a positive adjustment acquires at the stated price', () => {
      // 1.000,00 + 10 × 9,00 = 1.090,00 over 110 shares.
      // 1.090,00 ÷ 110 = 9,909090909…  → truncated at 8 places: 9,90909090
      const result = applyTransaction(
        HOLDING,
        aTransaction().adjustment().quantity('10').price('9.00').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('110');
      expect(result.value.totalCost.toString()).toBe('1090');
      expect(result.value.averageCost.toDecimal().toFixed(8)).toBe('9.90909090');
    });

    it('a negative adjustment removes at average cost, realising nothing', () => {
      // A bookkeeping correction is not a sale.
      // 1.000,00 − 10,00 × 10 = 900,00 over 90 shares, average still 10,00.
      const result = applyTransaction(
        HOLDING,
        aTransaction().adjustment().quantity('-10').price('9.00').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('90');
      expect(result.value.totalCost.toString()).toBe('900');
      expect(result.value.averageCost.toString()).toBe('10');
      expect(result.value.realizedGain.toString()).toBe('0');
    });

    it('refuses a negative adjustment larger than the position', () => {
      const result = applyTransaction(
        HOLDING,
        aTransaction().adjustment().quantity('-101').price('9.00').build(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context['requested']).toBe('101');
    });
  });

  describe('proventos leave the position untouched', () => {
    // SPEC-014 recognises these at pay date, in cash, never reinvested. A
    // dividend row carries the share count it was paid on, which must NOT be
    // mistaken for shares acquired — that would double the position.
    it.each(['dividend', 'jcp', 'rendimento', 'amortization'] as const)(
      'a %s changes nothing',
      (type) => {
        const row = { ...aTransaction().quantity('100').price('0.75').build(), type };
        const result = applyTransaction(HOLDING, row);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(HOLDING);
      },
    );
  });

  it('covers all thirteen BR-006-05 types without a default case', () => {
    // The dispatch has no `default`, so a fourteenth type would fail to
    // compile rather than silently becoming a no-op. This asserts the other
    // half: that all thirteen are actually reachable today.
    const handled: TransactionType[] = [
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
    ];
    for (const type of handled) {
      const base =
        type === 'split' || type === 'grupamento'
          ? aTransaction().split().ratio('2').build()
          : aTransaction().quantity('1').price('1').build();
      const result = applyTransaction(HOLDING, { ...base, type });
      expect(result.ok, `type ${type} must be handled`).toBe(true);
    }
  });
});
