import { getTranslations } from 'next-intl/server';
import { loadWalletChoices, loadWalletsPageData } from '@/app/(app)/wallets/data';
import { AssignQueue } from '@/app/(app)/settings/wallets/_components/AssignQueue';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { tryUserId } from '@/lib/session';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-05/15 — Configurações › Carteiras › **Atribuir ativos**:
 * what the user has to decide — purchases whose wallet was ambiguous
 * (SPEC-010 BR-010-12), wallets out of balance (SPEC-017 BR-017-17) — and the
 * standing rules (BR-010-14). The Painel's "Distribuir" items resolve here.
 *
 * Never statically prerendered: one tenant's own wallets and holdings.
 */
export const dynamic = 'force-dynamic';

export default async function AssignAssetsPage() {
  const t = await getTranslations('wallets');
  const userId = await tryUserId();

  if (userId === undefined) return <EmptyState title={t('signedOut')} />;

  const [wallets, { pending, standingRules, unbalanced, labels }] = await Promise.all([
    loadWalletChoices(userId),
    loadWalletsPageData(userId),
  ]);

  return (
    <WalletsSection>
      <AssignQueue
        walletChoices={wallets.map((wallet) => ({ id: wallet.id, name: wallet.name }))}
        pending={pending}
        standingRules={standingRules}
        unbalanced={unbalanced}
        labels={labels}
      />
    </WalletsSection>
  );
}
