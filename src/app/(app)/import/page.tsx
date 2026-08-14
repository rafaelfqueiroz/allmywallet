import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import { uploadExtractAction } from '@/app/(app)/import/actions';
import { listImportBatches } from '@/app/(app)/import/data';
import { tryUserId } from '@/app/(app)/import/session';

/**
 * SPEC-005 — upload, and the history of every batch this tenant has staged,
 * committed, cancelled or left pending.
 *
 * Never statically prerendered: this renders one tenant's own import
 * history, the same reasoning as `(app)/wallets/page.tsx`.
 */
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const t = await getTranslations('import');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  const batches = await listImportBatches(userId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-10 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('uploadTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('uploadHint')}</p>
        <form action={uploadExtractAction} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t('fileLabel')}
            <input
              type="file"
              name="file"
              accept=".xlsx,.xls"
              required
              className="rounded-md border px-2 py-1"
            />
          </label>
          <button
            type="submit"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {t('upload')}
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('historyTitle')}</h2>
        {batches.length === 0 ? (
          <p className="text-muted-foreground">{t('historyEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batches.map((batch) => (
              <li
                key={batch.id}
                className="flex items-center justify-between border-b pb-2 text-sm"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{t(`extractType.${batch.source}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(batch.uploadedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span>{t(`status.${batch.status}`)}</span>
                  <Link href={`/import/${batch.id}`} className="underline">
                    {t('viewDetails')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
