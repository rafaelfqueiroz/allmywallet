import { getTranslations } from 'next-intl/server';
import { loadOnboardingStatus } from '@/app/(app)/onboarding/data';
import { tryUserId } from '@/lib/session';
import { DismissButton } from '@/app/(app)/onboarding/_components/DismissButton';
import { GuidedSteps } from '@/app/(app)/onboarding/_components/GuidedSteps';
import { CompletionSummary } from '@/app/(app)/onboarding/_components/CompletionSummary';
import { PageShell } from '@/components/patterns/page-shell';
import { EmptyState } from '@/components/patterns/empty-state';

/**
 * SPEC-020 — the guided first run: export the three extracts, upload, review
 * the staged preview, commit (BR-020-04). Reached from `(app)/dashboard/page.tsx`'s
 * redirect (BR-020-02) and from the application shell's help entry point
 * (BR-020-13).
 *
 * **Everything here is read, nothing is computed.** `loadOnboardingStatus`
 * derives `stage`/`steps`/`complete` entirely by query (BR-020-06) — this page
 * only decides which section to show for the stage it is handed (AR-35).
 *
 * Never statically prerendered: this renders one tenant's own progress, the
 * same reasoning as `(app)/dashboard/page.tsx`.
 */
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const t = await getTranslations('onboarding');
  const userId = await tryUserId();

  if (userId === undefined) {
    return (
      <PageShell title={t('title')}>
        <EmptyState title={t('signedOut')} />
      </PageShell>
    );
  }

  const status = await loadOnboardingStatus(userId);

  return (
    <PageShell
      title={t('title')}
      description={t('description')}
      // BR-020-11 — dismissible at every stage, so this is not conditional on
      // `status.stage`.
      actions={<DismissButton />}
    >
      {status.stage === 'done' ? (
        <CompletionSummary steps={status.steps} />
      ) : (
        <GuidedSteps status={status} />
      )}
    </PageShell>
  );
}
