import { getTranslations } from 'next-intl/server';
import { UploadForm } from '@/app/(app)/settings/import/_components/UploadForm';
import { uploadExtractAction } from '@/app/(app)/import/actions';
import { listImportBatches, loadImportFreshness } from '@/app/(app)/import/data';
import { IMPORT_GUIDE_ANCHOR } from '@/app/(app)/import/paths';
import { tryUserId } from '@/lib/session';
import { ExportGuide } from '@/app/(app)/settings/import/_components/ExportGuide';
import { ImportSection } from '@/app/(app)/settings/import/_components/ImportSection';
import { StalenessPrompt } from '@/app/(app)/settings/import/_components/StalenessPrompt';
import { SettingsFrame } from '@/app/(app)/settings/_components/SettingsFrame';
import { PageShell } from '@/app/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';
import { Split } from '@/components/layout/split';

/**
 * SPEC-005 / SPEC-022 BR-022-16 — Configurações › Importar › **Enviar**: the
 * upload **beside** the B3 export guide (SPEC-020), so both are on screen
 * together. It was `/import`, which redirects here (BR-022-08).
 *
 * The history used to sit between the two and, at twenty-odd batches, pushed
 * the guide below the fold (#211). It is its own tab now, so this page is the
 * same height with three hundred imports as with none.
 *
 * Never statically prerendered: one tenant's own import state.
 */
export const dynamic = 'force-dynamic';

export default async function ImportSendPage() {
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
  const freshness = await loadImportFreshness(userId, batches);

  return (
    <SettingsFrame>
      <ImportSection>
        {/* BR-005-28 — non-blocking, above the upload control because that is
            the action it is asking for. */}
        {freshness.stale && (
          <StalenessPrompt
            daysSinceImport={freshness.daysSinceImport}
            thresholdDays={freshness.thresholdDays}
          />
        )}

        {/* Upload first, guide beside it. On a narrow container the two stack
            in that order; the guide's lead differs for a first run, which has
            no file yet and reads it as instructions rather than reference. */}
        <Split side="even">
          {/* SPEC-022 BR-022-37 — the standard form: Enviar at the footer's right. */}
          <UploadForm
            action={uploadExtractAction}
            panel={{ title: t('uploadTitle'), description: t('uploadHint') }}
          />
          <div id={IMPORT_GUIDE_ANCHOR}>
            <ExportGuide firstRun={freshness.firstRun} />
          </div>
        </Split>
      </ImportSection>
    </SettingsFrame>
  );
}
