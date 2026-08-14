import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { WalletId } from '@/core/shared/ids';
import { formatCurrency, formatQuantity } from '@/i18n/format';
import { deleteWalletAction, updateWalletAction } from '@/app/(app)/wallets/actions';
import { labelFor, loadWalletDetail } from '@/app/(app)/wallets/data';
import { tryUserId } from '@/app/(app)/wallets/session';

/** SPEC-010 BR-010-01/BR-010-07 — a single wallet's edit form and its allocated assets. */
export const dynamic = 'force-dynamic';

export default async function WalletDetailPage({
  params,
}: {
  params: Promise<{ walletId: string }>;
}) {
  const { walletId: rawWalletId } = await params;
  const t = await getTranslations('wallets');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawWalletId)) notFound();
  const walletId = WalletId.of(rawWalletId);
  const detail = await loadWalletDetail(userId, walletId);
  if (detail === null) notFound();

  const { wallet, allocations, labels } = detail;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-10">
      <Link href="/wallets" className="w-fit text-sm underline">
        {t('walletDetailBack')}
      </Link>

      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{wallet.name}</h1>
        <form action={updateWalletAction} className="flex flex-col gap-3">
          <input type="hidden" name="walletId" value={wallet.id} />
          <label className="flex flex-col gap-1 text-sm">
            {t('nameLabel')}
            <input
              name="name"
              defaultValue={wallet.name}
              className="w-64 rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('descriptionLabel')}
            <input
              name="description"
              defaultValue={wallet.description ?? ''}
              className="w-64 rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('goalLabel')}
            <input
              name="goal"
              defaultValue={wallet.goal ?? ''}
              className="w-64 rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('colorLabel')}
            <input
              name="color"
              type="color"
              defaultValue={wallet.color ?? '#000000'}
              className="h-9 w-14 rounded-md border"
            />
          </label>
          <button
            type="submit"
            className="w-fit rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {t('save')}
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('allocationsTitle')}</h2>
        {allocations.length === 0 ? (
          <p className="text-muted-foreground">{t('allocationsEmpty')}</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4">{t('columnAsset')}</th>
                <th className="py-2 pr-4">{t('columnQuantity')}</th>
                <th className="py-2">{t('columnCostBasis')}</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((allocation) => {
                const label = labelFor(labels, allocation.assetId);
                return (
                  <tr key={allocation.assetId} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {label.code} — {label.name}
                    </td>
                    <td className="py-2 pr-4">{formatQuantity(allocation.quantity)}</td>
                    <td className="py-2">
                      {allocation.costBasisAtAllocation === null
                        ? '—'
                        : formatCurrency(allocation.costBasisAtAllocation)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <form action={deleteWalletAction}>
          <input type="hidden" name="walletId" value={wallet.id} />
          <button
            type="submit"
            className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-accent"
          >
            {t('delete')}
          </button>
        </form>
      </section>
    </main>
  );
}
