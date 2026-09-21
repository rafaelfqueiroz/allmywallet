import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetId, ConversionGroupId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import type { TransactionWriteDeps } from '@/app/(app)/transactions/composition';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireUserId: vi.fn() }));
vi.mock('@/app/(app)/transactions/composition', () => ({
  withTransactionWriteDeps: vi.fn(),
}));
vi.mock('@/core/ledger/edit-transaction', () => ({ editTransaction: vi.fn() }));
vi.mock('@/core/ledger/delete-transaction', () => ({ deleteTransaction: vi.fn() }));
vi.mock('@/core/ledger/bulk-delete-transactions', () => ({ bulkDeleteTransactions: vi.fn() }));
vi.mock('@/core/ledger/manage-asset-conversion', () => ({
  deleteAssetConversionGroup: vi.fn(),
  replaceAssetConversionGroup: vi.fn(),
}));
vi.mock('@/core/wallets/reconcile-allocations', () => ({
  reconcileAllocationsToHoldings: vi.fn(),
}));

import { requireUserId } from '@/lib/session';
import { withTransactionWriteDeps } from '@/app/(app)/transactions/composition';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { deleteTransaction } from '@/core/ledger/delete-transaction';
import { bulkDeleteTransactions } from '@/core/ledger/bulk-delete-transactions';
import {
  deleteAssetConversionGroup,
  replaceAssetConversionGroup,
} from '@/core/ledger/manage-asset-conversion';
import { reconcileAllocationsToHoldings } from '@/core/wallets/reconcile-allocations';
import {
  bulkTransactionsAction,
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
      value: { deletedCount: 2 },
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

  it('recomputes an outgoing leg’s cash from the edited quantity (#143)', async () => {
    // SPEC-007 BR-007-05b: 90 redeemed at 2,239 carried 201,51 of cash; edited
    // to 80 the leg must carry 80 × 2,239 = 179,12, never the stale 201,51.
    const out = {
      ...conversion,
      id: TransactionId.of('01920000-0000-7000-8000-000000000011'),
      quantity: Quantity.fromString('90'),
      unitPrice: Money.fromString('2.239'),
      fees: Money.zero(),
      totalValue: Money.fromString('201.51'),
    } as Transaction;
    const incoming = {
      ...conversion,
      id: TransactionId.of('01920000-0000-7000-8000-000000000012'),
      type: 'conversion_in',
      quantity: Quantity.fromString('83.89'),
      unitPrice: Money.zero(),
      fees: Money.zero(),
      totalValue: Money.zero(),
    } as Transaction;
    vi.mocked(deps.ledger.transactions.listByConversionGroup).mockResolvedValueOnce([
      out,
      incoming,
    ]);
    (deps.ledger as unknown as { clock: { now: () => Date } }).clock = { now: () => new Date() };
    vi.mocked(replaceAssetConversionGroup).mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_CONVERSION_GROUP', context: {} },
    } as never);
    const data = new FormData();
    data.set('conversionGroupId', conversion.conversionGroupId as string);
    for (const [id, quantity, cost] of [
      [out.id, '80', '8000'],
      [incoming.id, '83.89', '7820.88'],
    ]) {
      data.append('legId', id as string);
      data.append('quantity', quantity as string);
      data.append('costBasis', cost as string);
    }

    await editAssetConversionGroupAction({ status: 'idle' }, data);

    const replacements = vi.mocked(replaceAssetConversionGroup).mock.calls[0]?.[2] ?? [];
    expect(replacements.map((leg) => leg.totalValue.toString())).toEqual(['179.12', '0']);
  });
});
