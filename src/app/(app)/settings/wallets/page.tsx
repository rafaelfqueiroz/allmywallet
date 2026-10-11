import { getTranslations } from 'next-intl/server';
import { loadWalletList } from '@/app/(app)/wallets/data';
import { WalletList } from '@/app/(app)/settings/wallets/_components/WalletList';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-05 — Configurações › Carteiras › **Minhas carteiras**: the
 * wallets as a list, each linking to its own page (edit, assign, rules,
 * delete). Setup data only — no portfolio figure.
 *
 * Never statically prerendered: one tenant's own wallets.
 */
export const dynamic = 'force-dynamic';

export default async function WalletsSettingsPage() {
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
        <WalletList rows={rows} />
      </WalletsSection>
    </SettingsFrame>
  );
}
