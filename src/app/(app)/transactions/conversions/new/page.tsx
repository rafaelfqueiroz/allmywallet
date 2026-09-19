import { getTranslations } from 'next-intl/server';
import { createAssetConversionGroupAction } from '@/app/(app)/transactions/actions';
import { withTransactionsDeps } from '@/app/(app)/transactions/composition';
import { listAssetOptions, listInstitutionOptions } from '@/app/(app)/transactions/data';
import { NewConversionGroupForm } from '@/app/(app)/transactions/_components/NewConversionGroupForm';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { tryUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function NewAssetConversionPage() {
  const t = await getTranslations('transactions.conversionGroup');
  const common = await getTranslations('transactions');
  const userId = await tryUserId();
  if (userId === undefined) {
    return (
      <PageShell title={t('createTitle')}>
        <EmptyState title={common('signedOut')} />
      </PageShell>
    );
  }
  const options = await withTransactionsDeps(userId, async (_deps, tx) => ({
    assets: await listAssetOptions(tx),
    institutions: await listInstitutionOptions(),
  }));
  return (
    <PageShell title={t('createTitle')} description={t('createDescription')} width="wide">
      <NewConversionGroupForm
        action={createAssetConversionGroupAction}
        assets={options.assets}
        institutions={options.institutions}
      />
    </PageShell>
  );
}
