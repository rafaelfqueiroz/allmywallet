import { getTranslations } from 'next-intl/server';
import { WalletsSection } from '@/app/(app)/settings/wallets/_components/WalletsSection';
import { ParameterSection } from '@/app/parameter-form';
import { tryUserId } from '@/lib/session';
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
  const userId = await tryUserId();

  if (userId === undefined) return <EmptyState title={t('signedOut')} />;

  return (
    <WalletsSection>
      <ParameterSection surface="settings.wallets" />
    </WalletsSection>
  );
}
