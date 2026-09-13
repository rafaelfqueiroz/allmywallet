import { useTranslations } from 'next-intl';
import { signIn } from '@/auth';
import { AuthShell } from '@/components/patterns/auth-shell';
import { Stack } from '@/components/layout/stack';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * SPEC-001: the only entry point into the product. BR-001-01: Google OAuth is
 * the only sign-in method — no password field, no "forgot password" link, no
 * credential input anywhere on this page or its acceptance criteria's checked
 * elsewhere. BR-001-12: the no-recovery consequence of single-provider auth
 * is disclosed here, plainly, before the user commits — not buried in terms.
 */
export default function SignInPage() {
  const t = useTranslations('auth.signIn');

  async function signInWithGoogle(): Promise<void> {
    'use server';
    // SPEC-001 BR-001-02: scope is pinned in src/auth.ts's provider config,
    // not here — this call never widens it.
    //
    // SPEC-001 BR-001-04 — sign-in routes to the dashboard, which is what the
    // rule has asked for since M0 and what #98 finally built. Not `/`: since
    // #37 the root is a marketing page, and landing a user who has just signed
    // in on the pitch that persuaded them to is a dead end.
    //
    // **The onboarding divergence lives one hop downstream, not here.**
    // BR-001-04's exact words are "routes to onboarding", and #97 (SPEC-020)
    // meets that in `(app)/dashboard/page.tsx`: every sign-in still lands on
    // `/dashboard`, which redirects on to `/onboarding` when
    // `loadOnboardingStatus` says `shouldGuide` — a first run with no
    // dismissal. A returning user, or one who dismissed the guide, falls
    // straight through. Keeping the divergence there rather than here is what
    // let #98 land the dashboard as everyone's landing first and #97 add the
    // branch afterwards without this file, or BR-001-04's own redirect target,
    // changing at all.
    await signIn('google', { redirectTo: '/dashboard' });
  }

  return (
    <AuthShell title={t('title')} description={t('description')}>
      <Stack gap="md">
        <form action={signInWithGoogle}>
          <Button type="submit" size="lg" className="w-full">
            {t('googleButton')}
          </Button>
        </form>
        {/* BR-001-12 acceptance criterion: stated on the sign-up screen itself. */}
        <Text tone="muted">{t('noRecoveryNotice')}</Text>
      </Stack>
    </AuthShell>
  );
}
