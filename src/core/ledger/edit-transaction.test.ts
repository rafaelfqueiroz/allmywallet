import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import { TransactionId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { TRANSACTION_TYPES, type Transaction } from '@/core/ledger/transaction';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';

const CLOCK = new FakeClock('2026-06-30T12:00:00Z');

function deps(rows: readonly Transaction[]): LedgerDependencies & {
  transactions: FakeTransactionRepository;
  positions: FakePositionRepository;
} {
  return {
    transactions: new FakeTransactionRepository(rows),
    positions: new FakePositionRepository(),
    clock: CLOCK,
  };
}

describe('SPEC-006 BR-006-12 — editTransaction', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  /**
   * AC: "All thirteen transaction types can be created, edited and deleted."
   * `create-transaction.test.ts` covers the create third; this is the edit
   * third, and it is not a formality — an edit re-runs the whole draft
   * validation *and* BR-006-15's replay on the way back out, so a type is only
   * genuinely editable if it survives both. A split whose ratio is dropped by
   * the edit path would be refused here and nowhere else.
   *
   * The opening buy is what makes the reducing types testable at all: a `sell`
   * or a `transfer_out` edited into a ledger holding nothing is correctly
   * refused, so a fixture with only the subject row would prove the opposite
   * of what this claims. That is exactly the shape the first version of this
   * test had, and it failed on those two types.
   */
  it('AC — every one of the thirteen types can be edited', async () => {
    for (const type of TRANSACTION_TYPES) {
      resetTransactionSequence();
      const opening = aTransaction().buy().on('2026-01-05').quantity('1000').price('10.00').build();
      const isRatioEvent = type === 'split' || type === 'grupamento';
      const subject = (
        isRatioEvent
          ? aTransaction().split().ratio('2').on('2026-02-05')
          : aTransaction().buy().on('2026-02-05').quantity('1').price('1.00')
      ).build();
      const state = deps([opening, { ...subject, type }]);

      const result = await editTransaction(state, subject.id, {
        // The one field every type shares and every type may change. Kept
        // after the opening buy, so a reducing type stays legal at its date.
        tradeDate: BusinessDate.of('2026-03-05'),
      });

      expect(result.ok, `type ${type} must be editable`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.transaction.tradeDate).toBe(BusinessDate.of('2026-03-05'));
      // BR-006-16: a human decided this value, whatever the type.
      expect(result.value.transaction.isUserModified).toBe(true);
    }
  });

  it('AC — editing quantity recalculates the position and every dependent figure', async () => {
    // Before: 100 @ 10,00 → total 1.000,00, average 10,00
    // After : 250 @ 10,00 → total 2.500,00, average 10,00, quantity 250
    const row = aTransaction().buy().quantity('100').price('10.00').build();
    const state = deps([row]);

    const result = await editTransaction(state, row.id, {
      quantity: Quantity.fromString('250'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.quantity.toString()).toBe('250');
    // The stored derivation is recomputed too, not left stale.
    expect(result.value.transaction.totalValue.toString()).toBe('2500');

    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('250');
    expect(positions[0]?.state.totalCost.toString()).toBe('2500');
  });

  it('AC / BR-006-16 — an edited imported row is flagged, so a re-import cannot revert it', async () => {
    const row = aTransaction().buy().imported('batch-a').quantity('100').price('10.00').build();
    expect(row.isUserModified).toBe(false);

    const state = deps([row]);
    const result = await editTransaction(state, row.id, { quantity: Quantity.fromString('120') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.isUserModified).toBe(true);
    // Provenance is preserved — the row is still traceable to its batch.
    expect(result.value.transaction.importBatchId).toBe(row.importBatchId);
    expect(result.value.transaction.isManual).toBe(false);
  });

  it('re-derives the natural key when an identifying field changes', async () => {
    // BR-006-04: leaving the old key would let a re-import match this row
    // against a trade it is no longer a record of.
    const row = aTransaction().buy().quantity('100').price('10.00').build();
    const state = deps([row]);

    const result = await editTransaction(state, row.id, { unitPrice: Money.fromString('11.00') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.naturalKey).not.toBe(row.naturalKey);
  });

  it('leaves untouched fields exactly as they were', async () => {
    const row = aTransaction().buy().at('Clear').quantity('100').price('10.00').fees('3').build();
    const state = deps([row]);

    const result = await editTransaction(state, row.id, { fees: Money.fromString('4') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.quantity.toString()).toBe('100');
    expect(result.value.transaction.unitPrice.toString()).toBe('10');
    expect(result.value.transaction.institutionId).toBe(institutionIdFor('Clear'));
    expect(result.value.transaction.tradeDate).toBe(row.tradeDate);
    expect(result.value.transaction.createdAt).toBe(row.createdAt);
    // 100 × 10,00 + 4,00 = 1.004,00
    expect(result.value.transaction.totalValue.toString()).toBe('1004');
  });

  it('can clear a nullable field explicitly, distinguishing null from absent', async () => {
    const row = aTransaction().buy().at('Clear').build();
    const state = deps([row]);

    const result = await editTransaction(state, row.id, { institutionId: null });
    expect(result.ok && result.value.transaction.institutionId).toBeNull();
  });

  it('AC — an unclassified row can be classified, and the position changes', async () => {
    const active = aTransaction().buy().quantity('100').price('10.00').build();
    const pending = aTransaction()
      .buy()
      .quantity('50')
      .price('20.00')
      .status('unclassified')
      .build();
    const state = deps([active, pending]);

    const result = await editTransaction(state, pending.id, { status: 'active' });
    expect(result.ok).toBe(true);

    // 1.000,00 + 1.000,00 = 2.000,00 over 150 shares
    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('150');
    expect(positions[0]?.state.totalCost.toString()).toBe('2000');
  });

  describe('moving a transaction between positions', () => {
    it('recalculates both the source and the destination', async () => {
      // A buy at Clear, misfiled: it belongs at Rico. Recalculating only the
      // destination would leave Clear permanently overstated — invisible until
      // a rebuild disagreed with it.
      const rows = [
        aTransaction().buy().at('Clear').quantity('100').price('10.00').build(),
        aTransaction().buy().at('Rico').quantity('40').price('25.00').build(),
      ];
      const state = deps(rows);
      const misfiled = rows[0];
      if (!misfiled) return;

      const result = await editTransaction(state, misfiled.id, {
        institutionId: institutionIdFor('Rico'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recalculations).toHaveLength(2);

      const positions = await state.positions.list();
      // Clear has nothing left, so its cached row is removed rather than left
      // showing 100 shares that no transaction supports.
      expect(positions).toHaveLength(1);
      // Rico: 1.000,00 + 1.000,00 = 2.000,00 over 140 shares.
      // 2.000,00 ÷ 140 = 14,285714285714…  → truncated at 8 places: 14,28571428
      expect(positions[0]?.state.quantity.toString()).toBe('140');
      expect(positions[0]?.state.totalCost.toString()).toBe('2000');
      expect(positions[0]?.state.averageCost.toDecimal().toFixed(8)).toBe('14.28571428');
    });

    it('refuses a move that would strand a sale at the source', async () => {
      const rows = [
        aTransaction().buy().at('Clear').on('2026-01-05').quantity('100').price('10.00').build(),
        aTransaction().sell().at('Clear').on('2026-02-05').quantity('100').price('12.00').build(),
      ];
      const state = deps(rows);
      const buy = rows[0];
      if (!buy) return;

      const result = await editTransaction(state, buy.id, {
        institutionId: institutionIdFor('Rico'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(state.transactions.updateCount).toBe(0);
    });

    it('recalculates from the earlier of the old and the new trade date', async () => {
      // DL-006-03: moving a trade from March to June makes March stale too.
      // Taking the new date alone would leave every figure between the two
      // showing a position no transaction supports.
      const row = aTransaction().buy().on('2026-03-01').build();
      const state = deps([row]);

      const result = await editTransaction(state, row.id, {
        tradeDate: BusinessDate.of('2026-06-01'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recalculations[0]?.scope.fromDate).toBe('2026-03-01');
    });

    it('recalculates from the earlier date when a trade moves backwards too', async () => {
      const row = aTransaction().buy().on('2026-06-01').build();
      const state = deps([row]);

      const result = await editTransaction(state, row.id, {
        tradeDate: BusinessDate.of('2026-03-01'),
      });
      expect(result.ok && result.value.recalculations[0]?.scope.fromDate).toBe('2026-03-01');
    });

    it('recalculates a single position when the asset and institution are unchanged', async () => {
      const row = aTransaction().buy().build();
      const state = deps([row]);
      const result = await editTransaction(state, row.id, { fees: Money.fromString('1') });
      expect(result.ok && result.value.recalculations).toHaveLength(1);
    });

    it('handles a move to a different asset', async () => {
      const row = aTransaction().buy().of('PETR4').quantity('10').price('30.00').build();
      const state = deps([row]);

      const result = await editTransaction(state, row.id, { assetId: assetIdFor('VALE3') });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const positions = await state.positions.list();
      expect(positions).toHaveLength(1);
      expect(positions[0]?.assetId).toBe(assetIdFor('VALE3'));
    });
  });

  describe('refusals', () => {
    it('reports a transaction that does not exist', async () => {
      const state = deps([]);
      const missing = TransactionId.generate();
      const result = await editTransaction(state, missing, {
        quantity: Quantity.fromString('1'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TRANSACTION_NOT_FOUND');
      expect(result.error.context).toEqual({ transactionId: missing });
    });

    it('applies the same field validation as creation', async () => {
      const row = aTransaction().buy().build();
      const state = deps([row]);

      const result = await editTransaction(state, row.id, { quantity: Quantity.zero() });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_QUANTITY');
      expect(state.transactions.updateCount).toBe(0);
    });

    it('refuses an edit that would make a later sale impossible', async () => {
      // Reducing the buy from 100 to 10 strands the 100-share sale that
      // follows it. BR-006-15's guard is on the resulting ledger, not on the
      // edited row in isolation.
      const rows = [
        aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
        aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
      ];
      const state = deps(rows);
      const buy = rows[0];
      if (!buy) return;

      const result = await editTransaction(state, buy.id, { quantity: Quantity.fromString('10') });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context).toEqual({ held: '10', requested: '100', date: '2026-02-05' });
      expect(state.transactions.updateCount).toBe(0);
    });

    it('permits the same edit when nothing later depends on it', async () => {
      const row = aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build();
      const state = deps([row]);
      const result = await editTransaction(state, row.id, { quantity: Quantity.fromString('10') });
      expect(result.ok).toBe(true);
    });

    it('refuses moving a trade date into the future', async () => {
      const row = aTransaction().buy().build();
      const state = deps([row]);
      const result = await editTransaction(state, row.id, {
        tradeDate: BusinessDate.of('2026-07-01'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('FUTURE_TRADE_DATE');
    });
  });

  it('changes the type, and the engine follows', async () => {
    // A row imported as a buy that was really a bonificação: 100 free shares.
    //   as a buy         : total 1.000,00 over 100 → average 10,00
    //   as a bonificação : the price becomes the attributed value
    const row = aTransaction().buy().quantity('100').price('10.00').build();
    const state = deps([row]);

    const result = await editTransaction(state, row.id, {
      type: 'bonificacao',
      unitPrice: Money.zero(),
    });
    expect(result.ok).toBe(true);

    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('100');
    expect(positions[0]?.state.totalCost.toString()).toBe('0');
    expect(positions[0]?.state.averageCost.toString()).toBe('0');
  });
});
