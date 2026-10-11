import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { WalletId } from '@/core/shared/ids';
import { loadWalletDetail } from '@/app/(app)/wallets/data';
import { WalletDetail } from '@/app/(app)/settings/wallets/_components/WalletDetail';
import { tryUserId } from '@/lib/session';
import { PageShell } from '@/app/page-shell';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-022 BR-022-05 / SPEC-010 BR-010-01/03/07/09/14 — **one wallet's setup**:
 * edit it, see and add its assets, its standing rules, delete it. It was
 * `/wallets/[walletId]`, which redirects here (BR-022-08).
 *
 * Never statically prerendered: one tenant's own wallet.
 */
export const dynamic = 'force-dynamic';

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const { walletId: rawWalletId } = await params;
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

  if (!/^[0-9a-f-]{36}$/i.test(rawWalletId)) notFound();
  const detail = await loadWalletDetail(userId, WalletId.of(rawWalletId));
  if (detail === null) notFound();

  return (
    <SettingsFrame>
      <WalletDetail detail={detail} />
    </SettingsFrame>
  );
}
