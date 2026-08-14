import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatCurrency, formatQuantity } from '@/i18n/format';
import {
  allocateAction,
  createWalletAction,
  deleteWalletAction,
  setStandingRuleAction,
} from '@/app/(app)/wallets/actions';
import { labelFor, loadWalletsPageData } from '@/app/(app)/wallets/data';
import { tryUserId } from '@/app/(app)/wallets/session';

/**
 * SPEC-010 — wallet CRUD, the Unassigned bucket (BR-010-06), the "Needs
 * attention" queue (BR-010-12) and a side-by-side comparison (BR-010-21).
 *
 * Never statically prerendered: this renders one tenant's own holdings and
 * allocations, so a cached copy built once (or with no session at all) would
 * be served to every visitor — the same reasoning as
 * `(settings)/preferences/page.tsx`.
 */
export const dynamic = 'force-dynamic';

export default async function WalletsPage() {
  const t = await getTranslations('wallets');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  const { comparison, unassigned, pending, labels } = await loadWalletsPageData(userId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-10 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('createTitle')}</h2>
        <form action={createWalletAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t('nameLabel')}
            <input
              name="name"
              required
              placeholder={t('namePlaceholder')}
              className="w-48 rounded-md border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('descriptionLabel')}
            <input name="description" className="w-48 rounded-md border px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('goalLabel')}
            <input name="goal" className="w-48 rounded-md border px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('colorLabel')}
            <input name="color" type="color" className="h-9 w-14 rounded-md border" />
          </label>
          <button
            type="submit"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {t('create')}
          </button>
        </form>
        <p className="text-xs text-muted-foreground">{t('goalHint')}</p>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium">{t('comparisonTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('comparisonDescription')}</p>
        </div>
        {comparison.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4">{t('columnWallet')}</th>
                <th className="py-2 pr-4">{t('columnAssetCount')}</th>
                <th className="py-2 pr-4">{t('columnQuantity')}</th>
                <th className="py-2 pr-4">{t('columnCostBasis')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.wallet.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">{row.wallet.name}</td>
                  <td className="py-2 pr-4">{row.assetCount}</td>
                  <td className="py-2 pr-4">{formatQuantity(row.totalQuantity)}</td>
                  <td className="py-2 pr-4">{formatCurrency(row.totalCostBasis)}</td>
                  <td className="py-2">
                    <Link href={`/wallets/${row.wallet.id}`} className="text-sm underline">
                      {t('viewDetails')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-medium">{t('unassignedTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('unassignedDescription')}</p>
        </div>
        {unassigned.length === 0 ? (
          <p className="text-muted-foreground">{t('unassignedEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {unassigned.map((holding) => {
              const label = labelFor(labels, holding.assetId);
              return (
                <li
                  key={holding.assetId}
                  className="flex items-center justify-between border-b pb-2 text-sm"
                >
                  <span>
                    {label.code} — {label.name}
                  </span>
                  <span>{formatQuantity(holding.quantity)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-medium">{t('needsAttentionTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('needsAttentionDescription')}</p>
        </div>
        {pending.length === 0 ? (
          <p className="text-muted-foreground">{t('needsAttentionEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {pending.map((item) => {
              const label = labelFor(labels, item.assetId);
              return (
                <li key={item.assetId} className="flex flex-col gap-2 border-b pb-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {label.code} — {label.name}
                    </span>
                    <span>{formatQuantity(item.unassignedQuantity)}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t(item.reason === 'no_wallet' ? 'reasonNoWallet' : 'reasonAmbiguousSplit')}
                  </span>
                  <div className="flex flex-wrap items-end gap-2">
                    <form action={allocateAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="assetId" value={item.assetId} />
                      <label className="flex flex-col gap-1 text-xs">
                        {t('resolveAssign')}
                        <select name="walletId" required className="rounded-md border px-2 py-1">
                          <option value="">{t('chooseWallet')}</option>
                          {comparison.map((row) => (
                            <option key={row.wallet.id} value={row.wallet.id}>
                              {row.wallet.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        {t('resolveQuantity')}
                        <input
                          name="quantity"
                          defaultValue={item.unassignedQuantity.toString()}
                          className="w-28 rounded-md border px-2 py-1"
                        />
                      </label>
                      <button
                        type="submit"
                        className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                      >
                        {t('resolveSubmit')}
                      </button>
                    </form>
                    <form action={setStandingRuleAction} className="flex items-end gap-2">
                      <input type="hidden" name="assetId" value={item.assetId} />
                      <select
                        name="walletId"
                        required
                        className="rounded-md border px-2 py-1 text-xs"
                      >
                        <option value="">{t('chooseWallet')}</option>
                        {comparison.map((row) => (
                          <option key={row.wallet.id} value={row.wallet.id}>
                            {row.wallet.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                      >
                        {t('standingRuleSet')}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('yourWallets')}</h2>
        {comparison.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comparison.map((row) => (
              <li key={row.wallet.id} className="flex items-center justify-between border-b pb-2">
                <Link href={`/wallets/${row.wallet.id}`} className="font-medium underline">
                  {row.wallet.name}
                </Link>
                <form action={deleteWalletAction}>
                  <input type="hidden" name="walletId" value={row.wallet.id} />
                  <button type="submit" className="text-sm text-destructive hover:underline">
                    {t('delete')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
