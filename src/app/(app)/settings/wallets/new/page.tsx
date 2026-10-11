import { getTranslations } from 'next-intl/server';
import { loadWalletList } from '@/app/(app)/wallets/data';
import { NewWalletPanel } from '@/app/(app)/settings/wallets/_components/NewWalletPanel';
import { WalletList } from '@/app/(app)/settings/wallets/_components/WalletList';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { EmptyState } from '@/components/patterns/empty-state';
import { Split } from '@/components/layout/split';

/**
 * SPEC-022 BR-022-05 — **Nova carteira**: the list with the form beside it, as
 * the approved prototype shows. A view of the first tab, which stays current on
 * it; stacked on a narrow container, where the form follows the list.
 *
 * Never statically prerendered: one tenant's own wallets.
 */
export const dynamic = 'force-dynamic';

export default async function NewWalletPage() {
  const t = await getTranslations('wallets');
  const ts = await getTranslations('settings');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={ts('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const rows = await loadWalletList(userId);

  return (
    <SettingsFrame>
      <WalletsSection>
        <Split side="end">
          <WalletList rows={rows} />
          <NewWalletPanel />
        </Split>
      </WalletsSection>
    </SettingsFrame>
  );
}
