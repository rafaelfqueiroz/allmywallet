import { beforeEach, describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { TRANSACTION_TYPES, type TransactionType } from '@/core/ledger/transaction';
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

  describe('BR-007-05a — fracao_bonificacao', () => {
    it('removes the fraction at unchanged total cost, ignoring the row’s price', () => {
      // 100 − 0,5 = 99,5 shares; total 1.000,00 unchanged.
      // average = 1.000,00 ÷ 99,5 = 2.000 ÷ 199 = 10,05025125…
      //   2.000 − 199 × 10 = 10 → 100 (0), 1.000 (5 r5), 50 (0), 500 (2 r102),
      //   1.020 (5 r25), 250 (1 r51), 510 (2 r112), 1.120 (5 r125)
      // The 99,00 "price" is ignored: the auction cash is a leilao_fracoes row.
      const result = applyTransaction(
        HOLDING,
        aTransaction().fracaoBonificacao().quantity('0.5').price('99.00').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('99.5');
      expect(result.value.totalCost.toString()).toBe('1000');
      expect(result.value.averageCost.toDecimal().toFixed(8)).toBe('10.05025125');
      expect(result.value.realizedGain.toString()).toBe('0');
    });

    it('refuses removing more than held', () => {
      const result = applyTransaction(
        HOLDING,
        aTransaction().fracaoBonificacao().quantity('100.5').build(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context['requested']).toBe('100.5');
    });
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

  describe('BR-007-05b — asset conversion legs', () => {
    it('removes a partial source quantity at moving-average cost with no realised gain', () => {
      // 100 @ 10,00 = 1.000,00. Converting out 40 removes 40 × 10,00 =
      // 400,00, leaving 60 shares / 600,00 / 10,00. There is no disposal,
      // therefore realised gain stays exactly zero whatever price the row has.
      const result = applyTransaction(
        HOLDING,
        aTransaction().conversionOut(undefined, '400').quantity('40').price('99.00').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('60');
      expect(result.value.totalCost.toString()).toBe('600');
      expect(result.value.averageCost.toString()).toBe('10');
      expect(result.value.realizedGain.toString()).toBe('0');
    });

    it('refuses a conversion_out larger than the source position', () => {
      // Only 100 shares exist; 100,00000001 is larger by one stored-scale unit.
      const result = applyTransaction(
        HOLDING,
        aTransaction().conversionOut(undefined, '1000').quantity('100.00000001').build(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context['held']).toBe('100');
      expect(result.error.context['requested']).toBe('100.00000001');
    });

    it('refuses a conversion_out whose allocated cost exceeds the source cost', () => {
      // Quantity alone is not enough to validate a persisted conversion leg:
      // removing 1.000,00000001 from a 1.000,00 lot would make its exact
      // remaining cost negative even though the requested 40 shares exist.
      const result = applyTransaction(
        HOLDING,
        aTransaction().conversionOut(undefined, '1000.00000001').quantity('40').build(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    });

    it('fails explicitly when conversion_out has no exact cost basis', () => {
      // Replay remains a trust boundary even though the database CHECK rejects
      // this shape on new writes.
      const transaction = {
        ...aTransaction().conversionOut(undefined, '400').quantity('40').build(),
        costBasis: null,
      };
      const result = applyTransaction(HOLDING, transaction);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MISSING_CONVERSION_COST_BASIS');
      expect(result.error.context['date']).toBe('2026-01-05');
    });

    it('adds exact carried cost rather than reconstructing it from unit price', () => {
      // Source: 100 @ 10,00 = 1.000,00. Conversion target: 50 shares receive
      // exactly 1.000,00, so average = 1.000,00 ÷ 50 = 20,00. The builder's
      // unit price is deliberately zero: cost_basis is the only authority.
      const result = applyTransaction(
        EMPTY_POSITION,
        aTransaction().conversionIn('1000.00000000').quantity('50').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('50');
      expect(result.value.totalCost.toString()).toBe('1000');
      expect(result.value.averageCost.toString()).toBe('20');
      expect(result.value.realizedGain.toString()).toBe('0');
    });

    it('blends exact carried cost into an existing target position', () => {
      // Existing target: 100 / 1.000,00. Incoming: 50 / 1.000,00.
      // Combined: 150 / 2.000,00; average = 2.000 ÷ 150 = 13,33333333…
      const result = applyTransaction(
        HOLDING,
        aTransaction().conversionIn('1000').quantity('50').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('150');
      expect(result.value.totalCost.toString()).toBe('2000');
      expect(result.value.averageCost.toDecimal().toFixed(8)).toBe('13.33333333');
    });

    it('permits an explicitly allocated zero cost', () => {
      // A zero-cost conversion leg is distinct from a missing allocation:
      // 10 target shares / 0,00 cost = average 0,00, but is still a position.
      const result = applyTransaction(
        EMPTY_POSITION,
        aTransaction().conversionIn('0').quantity('10').build(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quantity.toString()).toBe('10');
      expect(result.value.totalCost.toString()).toBe('0');
      expect(result.value.averageCost.toString()).toBe('0');
    });

    it('fails explicitly when conversion_in has no exact cost basis', () => {
      // The database CHECK rejects this shape, but replay must not silently
      // turn corrupt historical data into a plausible zero-cost holding.
      const transaction = {
        ...aTransaction().conversionIn('1000').quantity('50').build(),
        costBasis: null,
      };
      const result = applyTransaction(EMPTY_POSITION, transaction);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MISSING_CONVERSION_COST_BASIS');
      expect(result.error.context['date']).toBe('2026-01-05');
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
    it.each(['dividend', 'jcp', 'rendimento', 'amortization', 'leilao_fracoes'] as const)(
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

  it('covers all seventeen BR-006-05 types without a default case', () => {
    // The dispatch has no `default`, so an eighteenth type would fail to
    // compile rather than silently becoming a no-op. This asserts the other
    // half: that all seventeen are actually reachable today.
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
      'leilao_fracoes',
      'fracao_bonificacao',
      'conversion_out',
      'conversion_in',
    ];
    expect([...handled].sort()).toEqual([...TRANSACTION_TYPES].sort());
    for (const type of handled) {
      const base =
        type === 'split' || type === 'grupamento'
          ? aTransaction().split().ratio('2').build()
          : type === 'conversion_in'
            ? aTransaction().conversionIn('1').quantity('1').build()
            : type === 'conversion_out'
              ? aTransaction().conversionOut().quantity('1').build()
              : aTransaction().quantity('1').price('1').build();
      const result = applyTransaction(HOLDING, { ...base, type });
      expect(result.ok, `type ${type} must be handled`).toBe(true);
    }
  });
});
