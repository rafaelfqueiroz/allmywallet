import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import { TransactionId } from '@/core/shared/ids';
import { bulkDeleteTransactions } from '@/core/ledger/bulk-delete-transactions';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { deleteTransaction, describeDeletionImpact } from '@/core/ledger/delete-transaction';
import { TRANSACTION_TYPES, type Transaction } from '@/core/ledger/transaction';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
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

describe('SPEC-006 BR-006-13 — deleteTransaction', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  /**
   * The last third of "all thirteen transaction types can be created, edited
   * and deleted". Each type is deleted from a ledger that also holds an
   * opening buy, so removing it leaves a *replayable* history — the guard
   * BR-006-15 applies to a deletion is about what survives, and deleting the
   * only row of a position would test the empty case thirteen times instead.
   */
  it('AC — every one of the thirteen types can be deleted', async () => {
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

      const result = await deleteTransaction(state, subject.id);

      expect(result.ok, `type ${type} must be deletable`).toBe(true);
      if (!result.ok) continue;
      expect(result.value.deletedCount).toBe(1);
    }
  });

  it('removes the row and recalculates the position', async () => {
    // Two buys: 100 @ 10,00 and 100 @ 20,00 → 3.000,00 over 200, average 15,00.
    // Delete the second → 1.000,00 over 100, average 10,00.
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().buy().on('2026-02-05').quantity('100').price('20.00').build(),
    ];
    const state = deps(rows);
    const second = rows[1];
    if (!second) return;

    const result = await deleteTransaction(state, second.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedCount).toBe(1);
    expect(result.value.recalculation.scope.fromDate).toBe('2026-02-05');

    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('100');
    expect(positions[0]?.state.averageCost.toString()).toBe('10');
  });

  it('removes the cached position when the last transaction for it goes', async () => {
    // A stored position with no ledger behind it would contradict a rebuild
    // the moment anyone checked (DM-4).
    const row = aTransaction().buy().build();
    const state = deps([row]);
    await deleteTransaction(state, row.id);

    expect(await state.positions.list()).toEqual([]);
  });

  it('refuses to delete a buy that a later sale draws on', async () => {
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
    ];
    const state = deps(rows);
    const buy = rows[0];
    if (!buy) return;

    const result = await deleteTransaction(state, buy.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(result.error.context).toEqual({ held: '0', requested: '100', date: '2026-02-05' });
    expect(state.transactions.deleteCount).toBe(0);
  });

  it('permits deleting the sale itself', async () => {
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
    ];
    const state = deps(rows);
    const sale = rows[1];
    if (!sale) return;

    const result = await deleteTransaction(state, sale.id);
    expect(result.ok).toBe(true);

    const positions = await state.positions.list();
    expect(positions[0]?.state.quantity.toString()).toBe('100');
    expect(positions[0]?.state.realizedGain.toString()).toBe('0');
  });

  it('reports a transaction that does not exist', async () => {
    const state = deps([]);
    const result = await deleteTransaction(state, TransactionId.generate());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('AC — deleting shows what will be recalculated, before confirming', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('discloses the boundary date, the affected rows and both positions', async () => {
    // Ledger: 100 @ 10,00 (Jan), 100 @ 20,00 (Feb), 50 sold @ 30,00 (Mar).
    //   current : total 3.000,00 over 200 → average 15,00
    //             sale realises (30,00 − 15,00) × 50 = 750,00 → 150 left,
    //             total 3.000,00 − 15,00 × 50 = 2.250,00
    //   deleting the February buy leaves 100 @ 10,00 then the 50-share sale:
    //             realises (30,00 − 10,00) × 50 = 1.000,00
    //             50 left, total 1.000,00 − 10,00 × 50 = 500,00, average 10,00
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().buy().on('2026-02-05').quantity('100').price('20.00').build(),
      aTransaction().sell().on('2026-03-05').quantity('50').price('30.00').build(),
    ];
    const state = deps(rows);
    const target = rows[1];
    if (!target) return;

    const result = await describeDeletionImpact(state, target.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fromDate).toBe('2026-02-05');
    // The January buy is before the boundary; the March sale is after it.
    expect(result.value.subsequentTransactionCount).toBe(1);

    expect(result.value.currentPosition.quantity.toString()).toBe('150');
    expect(result.value.currentPosition.averageCost.toString()).toBe('15');
    expect(result.value.currentPosition.realizedGain.toString()).toBe('750');

    expect(result.value.projectedPosition.quantity.toString()).toBe('50');
    expect(result.value.projectedPosition.averageCost.toString()).toBe('10');
    expect(result.value.projectedPosition.totalCost.toString()).toBe('500');
    expect(result.value.projectedPosition.realizedGain.toString()).toBe('1000');
  });

  it('discloses nothing and deletes nothing when the deletion is impossible', async () => {
    // The user is told before confirming, rather than after the row is gone.
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
    ];
    const state = deps(rows);
    const buy = rows[0];
    if (!buy) return;

    const result = await describeDeletionImpact(state, buy.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(state.transactions.deleteCount).toBe(0);
  });

  it('reports an unreplayable current ledger rather than a plausible impact', async () => {
    // A ledger that is already inconsistent must not be described as if it
    // were fine — the disclosure would be arithmetic on a broken base.
    const rows = [
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
      aTransaction().buy().on('2026-03-05').quantity('100').price('10.00').build(),
    ];
    const state = deps(rows);
    const target = rows[1];
    if (!target) return;

    const result = await describeDeletionImpact(state, target.id);
    expect(result.ok).toBe(false);
  });

  it('reports a transaction that does not exist', async () => {
    const state = deps([]);
    const result = await describeDeletionImpact(state, TransactionId.generate());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('SPEC-006 BR-006-17 — bulk delete', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('AC — operates on a multi-selection across positions', async () => {
    const rows = [
      aTransaction().buy().of('PETR4').quantity('100').price('10.00').build(),
      aTransaction().buy().of('PETR4').quantity('50').price('20.00').build(),
      aTransaction().buy().of('VALE3').quantity('10').price('60.00').build(),
    ];
    const state = deps(rows);
    const [petrOne, , vale] = rows;
    if (!petrOne || !vale) return;

    const result = await bulkDeleteTransactions(state, [petrOne.id, vale.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedCount).toBe(2);
    expect(result.value.recalculations).toHaveLength(2);

    const positions = await state.positions.list();
    // PETR4 keeps its second buy; VALE3 has nothing left, so its row goes.
    expect(positions).toHaveLength(1);
    expect(positions[0]?.state.quantity.toString()).toBe('50');
  });

  it('accepts a buy and its dependent sale together, which row-by-row deletion could not', async () => {
    // Removing the buy alone is illegal; removing the pair is perfectly
    // ordinary — "undo these two duplicates". Validating each row in isolation
    // would refuse the whole case.
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
    ];
    const state = deps(rows);
    const [buy, sell] = rows;
    if (!buy || !sell) return;

    const result = await bulkDeleteTransactions(state, [buy.id, sell.id]);
    expect(result.ok).toBe(true);
    expect(await state.positions.list()).toEqual([]);
  });

  it('is all-or-nothing — a selection that leaves an impossible ledger deletes nothing', async () => {
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('100').price('12.00').build(),
      aTransaction().buy().of('VALE3').on('2026-01-05').quantity('10').price('60.00').build(),
    ];
    const state = deps(rows);
    const [buy, , vale] = rows;
    if (!buy || !vale) return;

    // Deleting the PETR4 buy strands its sale; the VALE3 buy would be fine on
    // its own and must still not be deleted.
    const result = await bulkDeleteTransactions(state, [buy.id, vale.id]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(state.transactions.deleteCount).toBe(0);
    expect(state.transactions.rows).toHaveLength(3);
  });

  it('recalculates from the earliest date touched in each position', async () => {
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().buy().on('2026-05-05').quantity('100').price('10.00').build(),
    ];
    const state = deps(rows);
    const [first, second] = rows;
    if (!first || !second) return;

    const result = await bulkDeleteTransactions(state, [second.id, first.id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recalculations).toHaveLength(1);
    expect(result.value.recalculations[0]?.scope.fromDate).toBe('2026-01-05');
  });

  it('refuses an empty selection', async () => {
    const state = deps([]);
    const result = await bulkDeleteTransactions(state, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_SELECTION');
  });

  it('refuses the whole operation if any id is unknown', async () => {
    const row = aTransaction().buy().build();
    const state = deps([row]);
    const result = await bulkDeleteTransactions(state, [row.id, TransactionId.generate()]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect(state.transactions.deleteCount).toBe(0);
  });

  it('de-duplicates a selection that names the same row twice', async () => {
    const row = aTransaction().buy().build();
    const state = deps([row]);
    const result = await bulkDeleteTransactions(state, [row.id, row.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedCount).toBe(1);
  });
});
