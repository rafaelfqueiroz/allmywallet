import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TransactionId } from '@/core/shared/ids';
import {
  editAssetConversionGroupAction,
  editTransactionAction,
} from '@/app/(app)/transactions/actions';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import {
  ASSET_CLASSES,
  listAssetOptions,
  listInstitutionOptions,
} from '@/app/(app)/transactions/data';
import { tryUserId } from '@/lib/session';
import { TransactionForm } from '@/app/(app)/transactions/_components/TransactionForm';
import { ConversionGroupForm } from '@/app/(app)/transactions/_components/ConversionGroupForm';
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

  const loaded = await withTransactionsDeps(userId, async (deps, tx) => {
    // RLS scopes this to the tenant, so another user's id is `null` here
    // rather than a forbidden row — the 404 below is the honest answer either
    // way, and says nothing about whether the row exists for someone else.
    const transaction = await deps.transactions.findById(TransactionId.of(transactionId));
    return {
      transaction,
      conversionGroup:
        transaction?.conversionGroupId === null || transaction === null
          ? []
          : await deps.transactions.listByConversionGroup(transaction.conversionGroupId),
      assetOptions: await listAssetOptions(tx),
      institutionOptions: await listInstitutionOptions(),
    };
  });

  if (loaded.transaction === null) notFound();
  const tx = loaded.transaction;

  if (tx.conversionGroupId !== null) {
    return (
      <PageShell width="wide" title={t('form.editTitle')} description={t('form.editDescription')}>
        <ConversionGroupForm
          action={editAssetConversionGroupAction}
          conversionGroupId={tx.conversionGroupId}
          legs={loaded.conversionGroup.map((leg) => ({
            id: leg.id,
            assetId: leg.assetId,
            type: leg.type === 'conversion_out' ? 'conversion_out' : 'conversion_in',
            tradeDate: leg.tradeDate,
            quantity: leg.quantity.toString(),
            costBasis: leg.costBasis?.toString() ?? '',
            ...(leg.type === 'conversion_out' && !leg.totalValue.isZero()
              ? { cash: leg.totalValue.toString() }
              : {}),
          }))}
        />
      </PageShell>
    );
  }

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
        assetClasses={ASSET_CLASSES}
        /*
          Empty on purpose, so AC-010-15's "which wallet sold" does not render
          here. An edit does not go through `applyLedgerEffects`: BR-006-14
          recalculates the position and `reconcile` brings allocations back
          under the sum invariant wholesale, so a per-edit wallet statement has
          nowhere to land. Offering the control and silently ignoring it would
          be worse than not offering it.
        */
        walletOptions={[]}
      />
    </PageShell>
  );
}
