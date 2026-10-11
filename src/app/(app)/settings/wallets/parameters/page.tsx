import { getTranslations } from 'next-intl/server';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { ParameterSection } from '@/app/parameter-form';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-13 — Configurações › Carteiras › **Parâmetros**: the
 * registry's user-settable keys for wallets (the drift tolerance), rendered by
 * the parameter-form pattern. This is the one page that owns the
 * `settings.wallets` surface; a key added to it appears here with no other
 * change.
 */
export const dynamic = 'force-dynamic';

export default async function WalletParametersPage() {
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

  return (
    <SettingsFrame>
      <WalletsSection>
        <ParameterSection surface="settings.wallets" />
      </WalletsSection>
    </SettingsFrame>
  );
}
