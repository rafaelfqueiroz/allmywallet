import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TransactionId } from '@/core/shared/ids';
import { editTransactionAction } from '@/app/(app)/transactions/actions';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import { listAssetOptions, listInstitutionOptions } from '@/app/(app)/transactions/data';
import { tryUserId } from '@/app/(app)/transactions/session';
import { TransactionForm } from '@/app/(app)/transactions/_components/TransactionForm';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-006 BR-006-12 / DL-006-02 — **any** transaction is editable, imported
 * ones included. Locking imported rows was considered and rejected: B3
 * extracts have gaps, and a user who cannot correct them keeps wrong numbers.
 * BR-006-16's `is_user_modified` flag, set by the use case, is what stops a
 * re-import reverting the correction.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly transactionId: string }>;
}

export default async function EditTransactionPage({ params }: PageProps) {
  const t = await getTranslations('transactions');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('form.editTitle')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const { transactionId } = await params;

  const loaded = await withTransactionsDeps(userId, async (deps, tx) => ({
    // RLS scopes this to the tenant, so another user's id is `null` here
    // rather than a forbidden row — the 404 below is the honest answer either
    // way, and says nothing about whether the row exists for someone else.
    transaction: await deps.transactions.findById(TransactionId.of(transactionId)),
    assetOptions: await listAssetOptions(tx),
    institutionOptions: await listInstitutionOptions(),
  }));

  if (loaded.transaction === null) notFound();
  const tx = loaded.transaction;

  return (
    <PageShell width="wide" title={t('form.editTitle')} description={t('form.editDescription')}>
      <TransactionForm
        action={editTransactionAction}
        mode="edit"
        values={{
          transactionId: tx.id,
          assetId: tx.assetId,
          institutionId: tx.institutionId ?? '',
          type: tx.type,
          tradeDate: tx.tradeDate,
          quantity: tx.quantity.toString(),
          unitPrice: tx.unitPrice.toString(),
          fees: tx.fees.toString(),
          ratio: tx.ratio?.toString() ?? '',
        }}
        assetOptions={loaded.assetOptions}
        institutionOptions={loaded.institutionOptions}
      />
    </PageShell>
  );
}
