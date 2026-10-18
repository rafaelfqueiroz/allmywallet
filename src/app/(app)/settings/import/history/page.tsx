import { getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import { listImportBatches } from '@/app/(app)/import/data';
import { tryUserId } from '@/lib/session';
import { typeDetected } from '@/app/(app)/settings/import/_components/batch-status';
import {
  ImportHistoryTable,
  type ImportHistoryRow,
} from '@/app/(app)/settings/import/_components/ImportHistoryTable';
import { ImportSection } from '@/app/(app)/settings/import/_components/ImportSection';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { Section } from '@/components/patterns/section';

/**
 * SPEC-005 / SPEC-022 BR-022-16/18 — Configurações › Importar › **Histórico**:
 * every batch this tenant has staged, committed, cancelled, left pending or
 * failed, as a sortable, paginated table.
 *
 * Never statically prerendered: one tenant's own import history.
 */
export const dynamic = 'force-dynamic';

export default async function ImportHistoryPage() {
  const t = await getTranslations('import');
  const ts = await getTranslations('settings');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={ts('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const batches = await listImportBatches(userId);
  const rows: ImportHistoryRow[] = batches.map((batch) => ({
    id: batch.id,
    typeLabel: typeDetected(batch) ? t(`extractType.${batch.source}`) : t('extractTypeUnknown'),
    status: batch.status,
    statusLabel: t(`status.${batch.status}`),
    sentAtText: formatDateTime(batch.uploadedAt),
    sentAtMs: batch.uploadedAt.getTime(),
    rowsRead: batch.rowCounts?.read ?? null,
  }));

  return (
    <ImportSection>
      {/* SPEC-022 BR-022-36 — the table in a panel titled with its count. */}
      <Section title={t('history.title', { count: rows.length })}>
        <ImportHistoryTable rows={rows} />
      </Section>
    </ImportSection>
  );
}
