import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ConversionGroupId, TransactionId, UserId } from '@/core/shared/ids';
import { domainError } from '@/core/shared/domain-error';
import { err, ok } from '@/core/shared/result';
import type { RecalculationOutcome } from '@/core/ledger/recalculate-from';
import { Money } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import type { TransactionWriteDeps } from '@/app/(app)/transactions/composition';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireUserId: vi.fn() }));
vi.mock('@/app/(app)/transactions/composition', () => ({
  withTransactionWriteDeps: vi.fn(),
}));
vi.mock('@/lib/queue', () => ({ enqueue: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/core/ledger/create-transaction', () => ({ createTransaction: vi.fn() }));
vi.mock('@/core/wallets/apply-ledger-effects', () => ({ applyLedgerEffects: vi.fn() }));
vi.mock('@/core/wallets/assign-transactions', () => ({ assignTransactionsToWallet: vi.fn() }));
vi.mock('@/core/ledger/edit-transaction', () => ({ editTransaction: vi.fn() }));
vi.mock('@/core/ledger/delete-transaction', () => ({ deleteTransaction: vi.fn() }));
vi.mock('@/core/ledger/bulk-delete-transactions', () => ({ bulkDeleteTransactions: vi.fn() }));
vi.mock('@/core/ledger/manage-asset-conversion', () => ({
  createAssetConversionGroup: vi.fn(),
  deleteAssetConversionGroup: vi.fn(),
  replaceAssetConversionGroup: vi.fn(),
}));
vi.mock('@/core/wallets/reconcile-allocations', () => ({
  reconcileAllocationsToHoldings: vi.fn(),
}));

import { requireUserId } from '@/lib/session';
import { withTransactionWriteDeps } from '@/app/(app)/transactions/composition';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { redirect } from 'next/navigation';
import { createTransaction } from '@/core/ledger/create-transaction';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { assignTransactionsToWallet } from '@/core/wallets/assign-transactions';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { deleteTransaction } from '@/core/ledger/delete-transaction';
import { bulkDeleteTransactions } from '@/core/ledger/bulk-delete-transactions';
import {
  createAssetConversionGroup,
  deleteAssetConversionGroup,
  replaceAssetConversionGroup,
} from '@/core/ledger/manage-asset-conversion';
import { reconcileAllocationsToHoldings } from '@/core/wallets/reconcile-allocations';
import {
  bulkTransactionsAction,
  createAssetConversionGroupAction,
  createTransactionAction,
  deleteTransactionAction,
  editAssetConversionGroupAction,
  editTransactionAction,
} from './actions';

const conversion = {
  type: 'conversion_out',
  assetId: AssetId.of('01920000-0000-7000-8000-000000000001'),
  conversionGroupId: ConversionGroupId.of('01920000-0000-7000-8000-000000000004'),
  costBasis: Money.fromString('10'),
} as Transaction;

const deps = {
  ledger: {
    transactions: {
      findById: vi.fn().mockResolvedValue(conversion),
      listByConversionGroup: vi.fn().mockResolvedValue([conversion]),
    },
  },
} as unknown as TransactionWriteDeps;

function transactionForm(type: string): FormData {
  const data = new FormData();
  data.set('transactionId', '01920000-0000-7000-8000-000000000002');
  data.set('assetId', '01920000-0000-7000-8000-000000000001');
  data.set('type', type);
  data.set('tradeDate', '2026-09-18');
  data.set('quantity', '1');
  data.set('unitPrice', '0');
  return data;
}

describe('transaction actions — grouped conversion boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUserId).mockResolvedValue(UserId.of('01920000-0000-7000-8000-000000000003'));
    vi.mocked(withTransactionWriteDeps).mockImplementation(async (_userId, callback) =>
      callback(deps),
    );
    vi.mocked(deleteAssetConversionGroup).mockResolvedValue({
      ok: true,
      value: { deletedCount: 2, fromDate: BusinessDate.of('2026-09-18') },
    });
    vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue({ ok: true, value: [] });
  });

  it('refuses standalone conversion creation before opening write dependencies', async () => {
    const result = await createTransactionAction(
      { status: 'idle' },
      transactionForm('conversion_in'),
    );

    expect(result).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED' });
    expect(withTransactionWriteDeps).not.toHaveBeenCalled();
  });

  it('refuses editing one existing conversion leg', async () => {
    const result = await editTransactionAction({ status: 'idle' }, transactionForm('buy'));

    expect(result).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED' });
    expect(editTransaction).not.toHaveBeenCalled();
  });

  it('deletes the complete conversion group when one linked leg is chosen', async () => {
    const data = new FormData();
    data.set('transactionId', '01920000-0000-7000-8000-000000000002');

    const result = await deleteTransactionAction({ status: 'idle' }, data);

    expect(result).toBeUndefined();
    expect(deleteAssetConversionGroup).toHaveBeenCalledWith(
      deps.ledger,
      conversion.conversionGroupId,
    );
    expect(deleteTransaction).not.toHaveBeenCalled();
  });

  it('refuses a bulk delete containing a conversion leg', async () => {
    const data = new FormData();
    data.set('operation', 'delete');
    data.append('selected', '01920000-0000-7000-8000-000000000002');

    const result = await bulkTransactionsAction({ status: 'idle' }, data);

    expect(result).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED' });
    expect(bulkDeleteTransactions).not.toHaveBeenCalled();
  });
});

/**
 * SPEC-009 BR-009-18 / SPEC-006 BR-006-14 — every ledger write that succeeds
 * asks the worker to rebuild `valuation.snapshot` from the earliest date its
 * figures went stale; one that fails, or writes no ledger row, asks for nothing.
 */
describe('transaction actions — SPEC-009 BR-009-18 snapshot rebuild request', () => {
  const USER = UserId.of('01920000-0000-7000-8000-000000000003');
  const ASSET = AssetId.of('01920000-0000-7000-8000-000000000001');
  const TX_ID = '01920000-0000-7000-8000-000000000002';
  const GROUP = ConversionGroupId.of('01920000-0000-7000-8000-000000000004');
  const IDLE_STATE = { status: 'idle' } as const;

  const plain = { type: 'buy', assetId: ASSET, conversionGroupId: null } as unknown as Transaction;
  const leg = (id: string, type: 'conversion_out' | 'conversion_in') =>
    ({
      id: TransactionId.of(id),
      type,
      assetId: ASSET,
      conversionGroupId: GROUP,
      costBasis: Money.fromString('10'),
    }) as unknown as Transaction;
  const writeDeps = {
    ledger: {
      transactions: {
        findById: vi.fn(),
        listByConversionGroup: vi.fn(),
      },
      clock: { now: () => new Date('2026-06-30T12:00:00Z') },
    },
  } as unknown as TransactionWriteDeps;

  const recalculated = (date: string): RecalculationOutcome => ({
    scope: { assetId: ASSET, institutionId: null, fromDate: BusinessDate.of(date) },
    position: null,
  });

  const createForm = () => {
    const data = new FormData();
    data.set('type', 'buy');
    data.set('assetId', ASSET);
    data.set('tradeDate', '2020-01-13');
    data.set('quantity', '10');
    data.set('unitPrice', '5,90');
    return data;
  };
  const editForm = () => {
    const data = createForm();
    data.set('transactionId', TX_ID);
    return data;
  };
  const deleteForm = () => {
    const data = new FormData();
    data.set('transactionId', TX_ID);
    return data;
  };
  const bulkForm = (operation: string) => {
    const data = new FormData();
    data.set('operation', operation);
    data.append('selected', TX_ID);
    return data;
  };
  const conversionForm = () => {
    const data = new FormData();
    data.set('sourceAssetId', ASSET);
    data.set('targetAssetId', '01920000-0000-7000-8000-000000000009');
    data.set('tradeDate', '2021-09-02');
    data.set('sourceQuantity', '10');
    data.set('targetQuantity', '20');
    data.set('costBasis', '100');
    return data;
  };
  const editGroupForm = () => {
    const data = new FormData();
    data.set('conversionGroupId', GROUP);
    for (const id of [
      '01920000-0000-7000-8000-0000000000a1',
      '01920000-0000-7000-8000-0000000000a2',
    ]) {
      data.append('legId', id);
      data.append('quantity', '10');
      data.append('costBasis', '100');
    }
    return data;
  };

  const expectRebuildFrom = (from: string) => {
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('valuation.snapshot', { userId: USER, from });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUserId).mockResolvedValue(USER);
    vi.mocked(withTransactionWriteDeps).mockImplementation(async (_userId, callback) =>
      callback(writeDeps),
    );
    vi.mocked(writeDeps.ledger.transactions.findById).mockResolvedValue(plain);
    vi.mocked(writeDeps.ledger.transactions.listByConversionGroup).mockResolvedValue([
      leg('01920000-0000-7000-8000-0000000000a1', 'conversion_out'),
      leg('01920000-0000-7000-8000-0000000000a2', 'conversion_in'),
    ]);
    vi.mocked(enqueue).mockResolvedValue(undefined);
    vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue({ ok: true, value: [] });
    vi.mocked(applyLedgerEffects).mockResolvedValue({ ok: true, value: undefined } as never);
  });

  describe('createTransactionAction', () => {
    beforeEach(() => {
      vi.mocked(createTransaction).mockResolvedValue(
        ok({
          transaction: plain,
          recalculation: recalculated('2020-01-13'),
        }),
      );
    });

    it('enqueues exactly one rebuild from the backdated row’s date, after the write', async () => {
      await createTransactionAction(IDLE_STATE, createForm());

      expectRebuildFrom('2020-01-13');
      expect(redirect).toHaveBeenCalledWith('/transactions');
    });

    it('enqueues nothing when the use case refuses', async () => {
      vi.mocked(createTransaction).mockResolvedValue(err(domainError('SELL_EXCEEDS_HOLDING')));

      const result = await createTransactionAction(IDLE_STATE, createForm());

      expect(result).toMatchObject({ status: 'error', code: 'SELL_EXCEEDS_HOLDING' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing when the wallet effects refuse', async () => {
      vi.mocked(applyLedgerEffects).mockResolvedValue(err(domainError('ALLOCATION_EXCEEDS')));

      const result = await createTransactionAction(IDLE_STATE, createForm());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      await createTransactionAction(IDLE_STATE, createForm());

      expect(redirect).toHaveBeenCalledWith('/transactions');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('enqueues nothing for input that never reaches the use case', async () => {
      await createTransactionAction(IDLE_STATE, new FormData());

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('createAssetConversionGroupAction', () => {
    it('enqueues one rebuild from the group’s date', async () => {
      vi.mocked(createAssetConversionGroup).mockResolvedValue(
        ok({ groupId: GROUP, fromDate: BusinessDate.of('2021-09-02') }),
      );

      await createAssetConversionGroupAction(IDLE_STATE, conversionForm());

      expectRebuildFrom('2021-09-02');
    });

    it('enqueues nothing when the group is refused', async () => {
      vi.mocked(createAssetConversionGroup).mockResolvedValue(
        err(domainError('INVALID_CONVERSION_GROUP')),
      );

      const result = await createAssetConversionGroupAction(IDLE_STATE, conversionForm());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('editTransactionAction', () => {
    it('enqueues from the earliest scope date — an edit moving a trade later still rebuilds from the old date', async () => {
      // The use case reports min(old, new) per position; the row moved from
      // 2020-01-13 to 2020-03-02 and a second position it left is stale from
      // the same date.
      vi.mocked(editTransaction).mockResolvedValue(
        ok({
          transaction: plain,
          recalculations: [recalculated('2020-01-13'), recalculated('2020-01-13')],
          rederived: [],
        }),
      );
      const data = editForm();
      data.set('tradeDate', '2020-03-02');

      await editTransactionAction(IDLE_STATE, data);

      expectRebuildFrom('2020-01-13');
    });

    it('takes the earliest of several positions', async () => {
      vi.mocked(editTransaction).mockResolvedValue(
        ok({
          transaction: plain,
          recalculations: [recalculated('2020-03-02'), recalculated('2020-01-13')],
          rederived: [],
        }),
      );

      await editTransactionAction(IDLE_STATE, editForm());

      expectRebuildFrom('2020-01-13');
    });

    it('enqueues nothing when the edit is refused, or reconciliation fails', async () => {
      vi.mocked(editTransaction).mockResolvedValue(err(domainError('SELL_EXCEEDS_HOLDING')));
      expect(await editTransactionAction(IDLE_STATE, editForm())).toMatchObject({
        status: 'error',
      });

      vi.mocked(editTransaction).mockResolvedValue(
        ok({ transaction: plain, recalculations: [recalculated('2020-01-13')], rederived: [] }),
      );
      vi.mocked(reconcileAllocationsToHoldings).mockResolvedValue(
        err(domainError('ALLOCATION_EXCEEDS')),
      );
      expect(await editTransactionAction(IDLE_STATE, editForm())).toMatchObject({
        status: 'error',
      });

      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(editTransaction).mockResolvedValue(
        ok({ transaction: plain, recalculations: [recalculated('2020-01-13')], rederived: [] }),
      );
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      await editTransactionAction(IDLE_STATE, editForm());

      expect(redirect).toHaveBeenCalledWith('/transactions');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('editAssetConversionGroupAction', () => {
    it('enqueues from the group’s earliest stale date', async () => {
      vi.mocked(replaceAssetConversionGroup).mockResolvedValue(
        ok({ groupId: GROUP, fromDate: BusinessDate.of('2021-09-02') }),
      );

      await editAssetConversionGroupAction(IDLE_STATE, editGroupForm());

      expectRebuildFrom('2021-09-02');
    });

    it('enqueues nothing when the replacement is refused', async () => {
      vi.mocked(replaceAssetConversionGroup).mockResolvedValue(
        err(domainError('INVALID_CONVERSION_GROUP')),
      );

      await editAssetConversionGroupAction(IDLE_STATE, editGroupForm());

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('deleteTransactionAction', () => {
    it('enqueues from the deleted row’s date', async () => {
      vi.mocked(deleteTransaction).mockResolvedValue(
        ok({
          deletedCount: 1,
          recalculation: recalculated('2020-02-10'),
          rederived: [],
          downstream: [],
        }),
      );

      await deleteTransactionAction(IDLE_STATE, deleteForm());

      expectRebuildFrom('2020-02-10');
    });

    it('rebuilds from a downstream re-derived position when it is earlier', async () => {
      vi.mocked(deleteTransaction).mockResolvedValue(
        ok({
          deletedCount: 1,
          recalculation: recalculated('2020-02-10'),
          rederived: [],
          downstream: [recalculated('2020-01-13')],
        }),
      );

      await deleteTransactionAction(IDLE_STATE, deleteForm());

      expectRebuildFrom('2020-01-13');
    });

    it('enqueues from the conversion group’s date when a group is deleted', async () => {
      vi.mocked(writeDeps.ledger.transactions.findById).mockResolvedValue(
        leg('01920000-0000-7000-8000-0000000000a1', 'conversion_out'),
      );
      vi.mocked(deleteAssetConversionGroup).mockResolvedValue(
        ok({ deletedCount: 2, fromDate: BusinessDate.of('2021-09-02') }),
      );

      await deleteTransactionAction(IDLE_STATE, deleteForm());

      expectRebuildFrom('2021-09-02');
    });

    it('enqueues nothing when the delete is refused', async () => {
      vi.mocked(deleteTransaction).mockResolvedValue(err(domainError('SELL_EXCEEDS_HOLDING')));

      const result = await deleteTransactionAction(IDLE_STATE, deleteForm());

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(deleteTransaction).mockResolvedValue(
        ok({
          deletedCount: 1,
          recalculation: recalculated('2020-02-10'),
          rederived: [],
          downstream: [],
        }),
      );
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      await deleteTransactionAction(IDLE_STATE, deleteForm());

      expect(redirect).toHaveBeenCalledWith('/transactions');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('bulkTransactionsAction', () => {
    it('enqueues once from the earliest date across every deleted row', async () => {
      vi.mocked(bulkDeleteTransactions).mockResolvedValue(
        ok({
          deletedCount: 3,
          recalculations: [recalculated('2021-09-02'), recalculated('2020-01-13')],
          rederived: [],
        }),
      );

      const result = await bulkTransactionsAction(IDLE_STATE, bulkForm('delete'));

      expect(result).toEqual({ status: 'deleted', deleted: 3 });
      expectRebuildFrom('2020-01-13');
    });

    it('enqueues nothing when the bulk delete is refused', async () => {
      vi.mocked(bulkDeleteTransactions).mockResolvedValue(err(domainError('EMPTY_SELECTION')));

      const result = await bulkTransactionsAction(IDLE_STATE, bulkForm('delete'));

      expect(result).toMatchObject({ status: 'error' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing for wallet assignment — it writes no ledger row', async () => {
      vi.mocked(assignTransactionsToWallet).mockResolvedValue(
        ok({ assigned: [TX_ID], skipped: [] }) as never,
      );
      const data = bulkForm('assign');
      data.set('walletId', '01920000-0000-7000-8000-0000000000b1');

      const result = await bulkTransactionsAction(IDLE_STATE, data);

      expect(result).toEqual({ status: 'assigned', assigned: 1, skipped: 0 });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still succeeds, and logs, when the enqueue throws', async () => {
      vi.mocked(bulkDeleteTransactions).mockResolvedValue(
        ok({ deletedCount: 1, recalculations: [recalculated('2020-01-13')], rederived: [] }),
      );
      vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

      const result = await bulkTransactionsAction(IDLE_STATE, bulkForm('delete'));

      expect(result).toEqual({ status: 'deleted', deleted: 1 });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
