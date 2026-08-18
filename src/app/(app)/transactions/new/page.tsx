import { getTranslations } from 'next-intl/server';
import { createTransactionAction } from '@/app/(app)/transactions/actions';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import {
  ASSET_CLASSES,
  listAssetOptions,
  listInstitutionOptions,
  listWalletChoices,
} from '@/app/(app)/transactions/data';
import { tryUserId } from '@/app/(app)/transactions/session';
import { TransactionForm } from '@/app/(app)/transactions/_components/TransactionForm';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-006 BR-006-11 — manual entry.
 *
 * "Manual entry is not a convenience feature": a B3 extract carries neither a
 * CDB bought at a bank nor anything before the export range, so without this
 * route those holdings do not exist in the product at all.
 *
 * Never statically prerendered — the asset and institution options are read
 * inside this tenant's own transaction.
 */
export const dynamic = 'force-dynamic';

export default async function NewTransactionPage() {
  const t = await getTranslations('transactions');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('form.createTitle')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const { assetOptions, institutionOptions, walletOptions } = await withTransactionsDeps(
    userId,
    async (_deps, tx) => ({
      assetOptions: await listAssetOptions(tx),
      institutionOptions: await listInstitutionOptions(),
      // AC-010-15's "which wallet sold". Tenant-scoped, so it reads inside the
      // page's own transaction (AR-11) rather than on the pooled `db`.
      walletOptions: await listWalletChoices(tx),
    }),
  );

  return (
    <PageShell width="wide" title={t('form.createTitle')} description={t('form.createDescription')}>
      <TransactionForm
        action={createTransactionAction}
        mode="create"
        values={{
          assetId: '',
          institutionId: '',
          type: 'buy',
          tradeDate: '',
          quantity: '',
          unitPrice: '',
          fees: '',
          ratio: '',
        }}
        assetOptions={assetOptions}
        institutionOptions={institutionOptions}
        assetClasses={ASSET_CLASSES}
        walletOptions={walletOptions}
      />
    </PageShell>
  );
}
