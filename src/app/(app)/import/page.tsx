import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import { uploadExtractAction } from '@/app/(app)/import/actions';
import { listImportBatches } from '@/app/(app)/import/data';
import { tryUserId } from '@/app/(app)/import/session';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { Field } from '@/components/patterns/field';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

  return (
    <PageShell title={t('title')} description={t('description')}>
      <Section title={t('uploadTitle')} description={t('uploadHint')}>
        <form action={uploadExtractAction}>
          <Cluster gap="md" align="end">
            <Field id="extract-file" label={t('fileLabel')}>
              <Input type="file" name="file" accept=".xlsx,.xls" required />
            </Field>
            <Button type="submit">{t('upload')}</Button>
          </Cluster>
        </form>
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
                    <Badge variant="secondary">{t(`status.${batch.status}`)}</Badge>
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
    </PageShell>
  );
}
