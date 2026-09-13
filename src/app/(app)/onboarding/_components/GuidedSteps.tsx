import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { OnboardingStatus } from '@/core/onboarding/status';
import { uploadExtractAction } from '@/app/(app)/import/actions';
import { UploadForm } from '@/app/(app)/import/_components/UploadForm';
import { ExportGuideContent } from '@/components/onboarding/export-guide-content';
import { Section } from '@/components/patterns/section';
import { List, ListItem } from '@/components/layout/list';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-020 BR-020-04 — "the guided sequence is: export the three extracts →
 * upload → review the staged preview → commit." Four named steps, rendered as
 * an ordered list (`<ol>` — the order is part of the meaning, exactly as
 * `ExportGuideContent`'s own list is) with each step's state read from
 * `OnboardingStatus.stage`, never re-derived here (AR-35: nothing in `app/`
 * decides what stage the tenant is in).
 *
 * **What this deliberately does not render** (BR-020-15/DL-020-05): a gate
 * list, a second "needs attention" panel, or a checklist of the data-quality
 * gates (`fixedIncomeRates`, `classification`). Those already have a home —
 * the dashboard's `AttentionQueue` — and BR-020-17 is explicit that they are
 * not part of onboarding completion at all. `queueNote` below is the one
 * sentence this page spends on them.
 *
 * `tests/structural/onboarding-has-no-gate-panel.test.ts` is the mechanical
 * backstop: this file and everything under `src/components/onboarding/` may
 * not import `AttentionQueue`, `describeGate`, or `core/dashboard`.
 */
export async function GuidedSteps({ status }: { readonly status: OnboardingStatus }) {
  const t = await getTranslations('onboarding');

  return (
    <Stack gap="lg">
      <List as="ol" gap="lg">
        <ListItem>
          <Section title={t('steps.export.title')} description={t('steps.export.description')}>
            <ExportGuideContent />
          </Section>
        </ListItem>

        <ListItem>
          <Section title={t('steps.upload.title')} description={t('steps.upload.description')}>
            {/* BR-020-22 — "together or one at a time, in any order". The form
                stays until the first commit: a user who sent Movimentação alone
                still has two extracts to send from here. */}
            <Stack gap="sm">
              {status.stage === 'processing' && (
                <Text size="sm" tone="muted">
                  {t('steps.upload.processing')}
                </Text>
              )}
              {status.stage === 'review' && (
                <Text size="sm" tone="muted">
                  {t('steps.upload.awaitingReview')}
                </Text>
              )}
              {status.stage !== 'done' && <UploadForm action={uploadExtractAction} />}
            </Stack>
          </Section>
        </ListItem>

        <ListItem>
          <Section title={t('steps.review.title')} description={t('steps.review.description')}>
            {status.stagedBatchId === null ? (
              <Text size="sm" tone="muted">
                {t('steps.review.upcoming')}
              </Text>
            ) : (
              <Cluster>
                <Button asChild variant="link" size="sm">
                  <Link href={`/import/${status.stagedBatchId}`}>
                    {status.stage === 'processing'
                      ? t('steps.review.processingLink')
                      : t('steps.review.reviewLink')}
                  </Link>
                </Button>
              </Cluster>
            )}
          </Section>
        </ListItem>

        <ListItem>
          <Section title={t('steps.commit.title')} description={t('steps.commit.description')}>
            {status.complete && (
              <Text size="sm" tone="muted">
                {t('steps.commit.done')}
              </Text>
            )}
          </Section>
        </ListItem>
      </List>

      {/* BR-020-15/DL-020-05 — at most one sentence pointing at the queue that
          already owns data-quality gates; never a second list of them here. */}
      <Text size="xs" tone="muted">
        {t('queueNote')}
      </Text>
    </Stack>
  );
}
