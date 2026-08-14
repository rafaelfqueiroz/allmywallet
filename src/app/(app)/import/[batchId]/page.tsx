import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ImportBatchId } from '@/core/shared/ids';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { formatDateTime } from '@/i18n/format';
import {
  acceptAdjustmentAction,
  cancelBatchAction,
  classifyRowAction,
  commitBatchAction,
} from '@/app/(app)/import/actions';
import { loadImportBatchDetail } from '@/app/(app)/import/data';
import { tryUserId } from '@/app/(app)/import/session';

/**
 * SPEC-005 BR-005-10/11/19/20/22..26 — the preview: accurate counts, the
 * Needs Attention queue with manual classification, commit/cancel, and the
 * reconciliation report with accept-as-adjustment.
 */
export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId: rawBatchId } = await params;
  const t = await getTranslations('import');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-6 py-10">
        <p role="status" className="text-muted-foreground">
          {t('signedOut')}
        </p>
      </main>
    );
  }

  if (!/^[0-9a-f-]{36}$/i.test(rawBatchId)) notFound();
  const batchId = ImportBatchId.of(rawBatchId);
  const detail = await loadImportBatchDetail(userId, batchId);
  if (detail === null) notFound();

  const { batch, rows, needsAttention } = detail;
  const canCommit = batch.status === 'previewed';
  const canCancel = batch.status === 'pending' || batch.status === 'previewed';

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t(`extractType.${batch.source}`)}
        </h1>
        <p className="text-muted-foreground">
          {t('uploadedAt', { date: formatDateTime(batch.uploadedAt) })}
        </p>
        <p className="font-medium">{t(`status.${batch.status}`)}</p>
      </div>

      {batch.rowCounts && (
        <section className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label={t('countRead')} value={batch.rowCounts.read} />
          <Stat label={t('countNew')} value={batch.rowCounts.new} />
          <Stat label={t('countDuplicates')} value={batch.rowCounts.duplicates} />
          <Stat label={t('countNeedsAttention')} value={batch.rowCounts.needsAttention} />
        </section>
      )}

      {(canCommit || canCancel) && (
        <div className="flex gap-3">
          {canCommit && (
            <form action={commitBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <button
                type="submit"
                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                {t('commit')}
              </button>
            </form>
          )}
          {canCancel && (
            <form action={cancelBatchAction}>
              <input type="hidden" name="batchId" value={batch.id} />
              <button type="submit" className="text-sm text-destructive hover:underline">
                {t('cancel')}
              </button>
            </form>
          )}
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t('needsAttentionTitle')}</h2>
        {needsAttention.length === 0 ? (
          <p className="text-muted-foreground">{t('needsAttentionEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {needsAttention.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 border-b pb-4 text-sm">
                <span className="font-medium">{row.record.assetCode}</span>
                <span className="text-xs text-muted-foreground">
                  {row.record.kind === 'transaction' ? row.record.b3Type : ''}
                </span>
                {row.classification === 'unclassified' && (
                  <form action={classifyRowAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="rowId" value={row.id} />
                    <label className="flex flex-col gap-1 text-xs">
                      {t('classifyLabel')}
                      <select name="type" required className="rounded-md border px-2 py-1">
                        {TRANSACTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`transactionType.${type}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                    >
                      {t('classifySubmit')}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {batch.reconciliation && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">{t('reconciliationTitle')}</h2>
          <p className="font-medium">{t(`reconciliationStatus.${batch.reconciliation.status}`)}</p>
          {batch.reconciliation.discrepancies.length > 0 && (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">{t('columnAsset')}</th>
                  <th className="py-2 pr-4">{t('columnComputed')}</th>
                  <th className="py-2 pr-4">{t('columnB3')}</th>
                  <th className="py-2 pr-4">{t('columnDifference')}</th>
                  <th className="py-2 pr-4">{t('columnCause')}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {batch.reconciliation.discrepancies.map((d) => (
                  <tr key={d.assetId} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">{d.assetCode}</td>
                    <td className="py-2 pr-4">{d.computedQuantity}</td>
                    <td className="py-2 pr-4">{d.b3Quantity}</td>
                    <td className="py-2 pr-4">{d.difference}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {t(`discrepancyCause.${d.cause}`)}
                    </td>
                    <td className="py-2">
                      {!d.resolved && (
                        <form action={acceptAdjustmentAction}>
                          <input type="hidden" name="batchId" value={batch.id} />
                          <input type="hidden" name="assetId" value={d.assetId} />
                          {d.institutionId && (
                            <input type="hidden" name="institutionId" value={d.institutionId} />
                          )}
                          <button
                            type="submit"
                            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                          >
                            {t('acceptAdjustment')}
                          </button>
                        </form>
                      )}
                      {d.resolved && (
                        <span className="text-xs text-muted-foreground">{t('resolved')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground">{t('rowsCount', { count: rows.length })}</p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
