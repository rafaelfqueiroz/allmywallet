import { getTranslations } from 'next-intl/server';
import { loadWalletsPageData } from '@/app/(app)/wallets/data';
import { loadScopeWallets } from '@/app/(app)/portfolio/data';
import { PortfolioFrame } from '@/app/(app)/portfolio/_components/PortfolioFrame';
import { WalletTabs } from '@/app/(app)/portfolio/wallets/_components/WalletTabs';
import { WalletSetup } from '@/app/(app)/portfolio/wallets/_components/WalletSetup';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { ParameterSection } from '@/app/parameter-form';
import { EmptyState } from '@/components/patterns/empty-state';
import { Stack } from '@/components/layout/stack';

/**
 * Portfólio › Carteiras › **Configurar** — SPEC-010 wallet setup: the "Precisa
 * de atenção" queue with its resolve forms (BR-010-12), standing rules
 * (BR-010-14), create and delete, and the drift tolerance.
 *
 * The last sub-tab of Carteiras, by the owner's decision on #208: setup stays
 * beside the wallets it configures until Configurações › Carteiras exists
 * (#210, BR-022-05), but never on the same page as the analysis (BR-022-15).
 * It is not scoped: setup applies to every wallet, so the header has no
 * scope selector (BR-022-14), and a wallet already in the URL is only carried
 * along for the way back.
 *
 * Never statically prerendered: one tenant's own wallets and holdings.
 */
export const dynamic = 'force-dynamic';

export default async function PortfolioWalletSetupPage() {
  const tp = await getTranslations('portfolio');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={tp('title')}>
        <EmptyState title={tp('signedOut')} />
      </PageShell>
    );
  }

  const [wallets, { pending, standingRules, unbalanced, labels }] = await Promise.all([
    loadScopeWallets(userId),
    loadWalletsPageData(userId),
  ]);

  return (
    <PortfolioFrame wallets={wallets} scoped={false}>
      <WalletTabs />
      <Stack gap="lg">
        <WalletSetup
          walletChoices={wallets.map((wallet) => ({ id: wallet.walletId, name: wallet.name }))}
          pending={pending}
          standingRules={standingRules}
          unbalanced={unbalanced}
          labels={labels}
        />
        {/* The drift tolerance (BR-022-13): rendered by this page, the one
            that owns the `settings.wallets` surface. */}
        <ParameterSection surface="settings.wallets" />
      </Stack>
    </PortfolioFrame>
  );
}
