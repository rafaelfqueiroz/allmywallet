import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import type { TransactionType } from '@/core/ledger/transaction';
import { validateTransactionDraft, type TransactionDraft } from '@/core/ledger/validate';

/** SPEC-006 BR-006-15 — the guards decidable from the row alone. */
const TODAY = BusinessDate.of('2026-06-30');

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    type: 'buy',
    tradeDate: BusinessDate.of('2026-06-01'),
    quantity: Quantity.fromString('100'),
    unitPrice: Money.fromString('10.00'),
    fees: Money.zero(),
    ratio: null,
    ...overrides,
  };
}

describe('validateTransactionDraft', () => {
  it('accepts an ordinary buy', () => {
    expect(validateTransactionDraft(draft(), TODAY).ok).toBe(true);
  });

  describe('trade date', () => {
    it('accepts today', () => {
      expect(validateTransactionDraft(draft({ tradeDate: TODAY }), TODAY).ok).toBe(true);
    });

    it('refuses a future date — a trade that has not happened is not a ledger entry', () => {
      const result = validateTransactionDraft(
        draft({ tradeDate: BusinessDate.of('2026-07-01') }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('FUTURE_TRADE_DATE');
      expect(result.error.context).toEqual({ tradeDate: '2026-07-01', today: '2026-06-30' });
    });

    it('takes "today" as an argument, never from the ambient clock', () => {
      // The same draft is valid or invalid depending only on the date passed
      // in — which is what makes this deterministic on a CI runner in UTC.
      const tradeDate = BusinessDate.of('2026-07-01');
      expect(validateTransactionDraft(draft({ tradeDate }), BusinessDate.of('2026-06-30')).ok).toBe(
        false,
      );
      expect(validateTransactionDraft(draft({ tradeDate }), BusinessDate.of('2026-07-01')).ok).toBe(
        true,
      );
    });
  });

  describe('quantity', () => {
    const POSITIVE_ONLY: readonly TransactionType[] = [
      'buy',
      'sell',
      'subscription',
      'transfer_in',
      'transfer_out',
      'bonificacao',
    ];

    it.each(POSITIVE_ONLY)('refuses a zero quantity on a %s', (type) => {
      const result = validateTransactionDraft(draft({ type, quantity: Quantity.zero() }), TODAY);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_QUANTITY');
      expect(result.error.context['reason']).toBe('not_positive');
    });

    it.each(POSITIVE_ONLY)('refuses a negative quantity on a %s', (type) => {
      // Direction is carried by the *type* — a sell of 100 is `quantity: 100`,
      // never −100. Allowing both encodings would mean two different answers
      // from the engine for the same trade.
      const result = validateTransactionDraft(
        draft({ type, quantity: Quantity.fromString('-1') }),
        TODAY,
      );
      expect(result.ok).toBe(false);
    });

    it('accepts a signed quantity on an adjustment, in both directions', () => {
      expect(
        validateTransactionDraft(
          draft({ type: 'adjustment', quantity: Quantity.fromString('10') }),
          TODAY,
        ).ok,
      ).toBe(true);
      expect(
        validateTransactionDraft(
          draft({ type: 'adjustment', quantity: Quantity.fromString('-10') }),
          TODAY,
        ).ok,
      ).toBe(true);
    });

    it('refuses a zero adjustment — it says nothing and nobody can interpret it later', () => {
      const result = validateTransactionDraft(
        draft({ type: 'adjustment', quantity: Quantity.zero() }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.context['reason']).toBe('zero');
    });

    it('accepts a zero quantity on a provento, whose quantity is informational', () => {
      expect(
        validateTransactionDraft(draft({ type: 'dividend', quantity: Quantity.zero() }), TODAY).ok,
      ).toBe(true);
    });

    it('refuses a negative quantity on a provento', () => {
      const result = validateTransactionDraft(
        draft({ type: 'jcp', quantity: Quantity.fromString('-5') }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.context['reason']).toBe('negative');
    });

    it('accepts a fractional quantity, as Tesouro Direto produces', () => {
      expect(
        validateTransactionDraft(draft({ quantity: Quantity.fromString('0.07') }), TODAY).ok,
      ).toBe(true);
    });
  });

  describe('prices and fees are magnitudes', () => {
    it('refuses a negative unit price', () => {
      const result = validateTransactionDraft(
        draft({ unitPrice: Money.fromString('-0.01') }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NEGATIVE_UNIT_PRICE');
      expect(result.error.context).toEqual({ unitPrice: '-0.01' });
    });

    it('accepts a zero unit price — a bonificação with nothing attributed', () => {
      expect(
        validateTransactionDraft(draft({ type: 'bonificacao', unitPrice: Money.zero() }), TODAY).ok,
      ).toBe(true);
    });

    it('refuses negative fees', () => {
      const result = validateTransactionDraft(draft({ fees: Money.fromString('-1') }), TODAY);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NEGATIVE_FEES');
    });
  });

  describe('SPEC-007 BR-007-04 — the ratio pairing', () => {
    it.each(['split', 'grupamento'] as const)('requires a ratio on a %s', (type) => {
      // Without one the event cannot be replayed, and BR-007-15 says exactly
      // what that costs: every subsequent average, silently.
      const result = validateTransactionDraft(draft({ type, ratio: null }), TODAY);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RATIO_REQUIRED');
      expect(result.error.context).toEqual({ type });
    });

    it.each([
      ['zero', '0'],
      ['negative', '-2'],
    ])('refuses a %s ratio on a split', (_label, ratio) => {
      const result = validateTransactionDraft(
        draft({ type: 'split', quantity: Quantity.zero(), ratio: Quantity.fromString(ratio) }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_RATIO');
    });

    it('accepts a valid split', () => {
      expect(
        validateTransactionDraft(
          draft({
            type: 'split',
            quantity: Quantity.zero(),
            unitPrice: Money.zero(),
            ratio: Quantity.fromString('2'),
          }),
          TODAY,
        ).ok,
      ).toBe(true);
    });

    it('refuses a ratio on a type that has no ratio semantics', () => {
      // A "buy" carrying a ratio is a mis-typed row. Storing it leaves a field
      // the engine ignores — which is how a split that was meant to be entered
      // becomes invisible.
      const result = validateTransactionDraft(
        draft({ type: 'buy', ratio: Quantity.fromString('2') }),
        TODAY,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RATIO_NOT_APPLICABLE');
      expect(result.error.context).toEqual({ type: 'buy', ratio: '2' });
    });
  });
});
