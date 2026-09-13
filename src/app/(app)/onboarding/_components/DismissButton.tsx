import { getTranslations } from 'next-intl/server';
import { dismissOnboardingAction } from '@/app/(app)/onboarding/actions';
import { Button } from '@/components/ui/button';

/**
 * SPEC-020 BR-020-11 — "the guide is dismissible at any step." One control,
 * rendered once in `PageShell`'s `actions` slot so it is reachable regardless
 * of which stage `OnboardingStatus.stage` is in, rather than a per-step
 * dismiss button that would have to be kept in sync across four sections.
 *
 * A real POST (BR-020-12): dismissal writes `users.onboarding_dismissed_at`,
 * so a `Link` would let a prefetch or a crawler dismiss the guide by GET.
 */
export async function DismissButton() {
  const t = await getTranslations('onboarding');

  return (
    <form action={dismissOnboardingAction}>
      <Button type="submit" variant="outline">
        {t('dismiss')}
      </Button>
    </form>
  );
}
