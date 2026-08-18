import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import { UploadForm } from '@/app/(app)/import/_components/UploadForm';
import { uploadExtractAction } from '@/app/(app)/import/actions';
import { listImportBatches, loadImportFreshness } from '@/app/(app)/import/data';
import { tryUserId } from '@/app/(app)/import/session';
import { ExportGuide } from '@/app/(app)/import/_components/ExportGuide';
import { StalenessPrompt } from '@/app/(app)/import/_components/StalenessPrompt';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { List, ListItem } from '@/components/layout/list';
import { Text } from '@/components/ui/text';

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
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const batches = await listImportBatches(userId);
  const freshness = await loadImportFreshness(userId, batches);

  return (
    <PageShell title={t('title')} description={t('description')}>
      {/* BR-005-28 — non-blocking, above the upload control because that is
          the action it is asking for. */}
      {freshness.stale && (
        <StalenessPrompt
          daysSinceImport={freshness.daysSinceImport}
          thresholdDays={freshness.thresholdDays}
        />
      )}

      {/* A first-run user gets the guide before the file picker: they do not
          have a file yet, and an upload box is not an instruction. Afterwards
          it moves below, where it is a reference rather than a lecture. */}
      {freshness.firstRun && (
        <div id="import-guide">
          <ExportGuide firstRun />
        </div>
      )}

      <Section title={t('uploadTitle')} description={t('uploadHint')}>
        <UploadForm action={uploadExtractAction} />
      </Section>

      <Section title={t('historyTitle')}>
        {batches.length === 0 ? (
          <EmptyState title={t('historyEmpty')} />
        ) : (
          <List gap="sm">
            {batches.map((batch) => (
              <ListItem key={batch.id} separated>
                <Cluster justify="between" gap="sm">
                  <span className="flex flex-col">
                    <span className="font-medium">{t(`extractType.${batch.source}`)}</span>
                    <Text as="span" size="xs" tone="muted">
                      {formatDateTime(batch.uploadedAt)}
                    </Text>
                  </span>
                  <Cluster gap="sm">
                    <Badge variant={batch.status === 'failed' ? 'destructive' : 'secondary'}>
                      {t(`status.${batch.status}`)}
                    </Badge>
                    <Button asChild variant="link" size="sm">
                      <Link href={`/import/${batch.id}`}>{t('viewDetails')}</Link>
                    </Button>
                  </Cluster>
                </Cluster>
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      {!freshness.firstRun && (
        <div id="import-guide">
          <ExportGuide firstRun={false} />
        </div>
      )}
    </PageShell>
  );
}
