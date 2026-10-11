import { getTranslations } from 'next-intl/server';
import { loadWalletList } from '@/app/(app)/wallets/data';
import { WalletList } from '@/app/(app)/settings/wallets/_components/WalletList';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { tryUserId } from '@/lib/session';
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
  const userId = await tryUserId();

  if (userId === undefined) return <EmptyState title={t('signedOut')} />;

  const rows = await loadWalletList(userId);

  return (
    <WalletsSection>
      <WalletList rows={rows} />
    </WalletsSection>
  );
}
