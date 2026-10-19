import { getTranslations } from 'next-intl/server';
import { loadWalletChoices, loadWalletsPageData } from '@/app/(app)/wallets/data';
import { AssignQueue } from '@/app/(app)/settings/wallets/_components/AssignQueue';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-05/15 — Configurações › Carteiras › **Atribuir ativos**:
 * what the user has to decide — purchases whose wallet was ambiguous
 * (SPEC-010 BR-010-12), wallets out of balance (SPEC-017 BR-017-17) — and the
 * standing rules (BR-010-14). The Dashboard's "Distribuir" items resolve here.
 *
 * `?resolve=<asset>` names the queue row whose forms are open (BR-022-18: the
 * queue is a table, and a table holds no form — see `AssignQueue`).
 *
 * Never statically prerendered: one tenant's own wallets and holdings.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AssignAssetsPage({ searchParams }: PageProps) {
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

  const raw = await searchParams;
  const resolve = typeof raw['resolve'] === 'string' ? raw['resolve'] : undefined;

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
        resolve={resolve}
      />
    </WalletsSection>
  );
}
