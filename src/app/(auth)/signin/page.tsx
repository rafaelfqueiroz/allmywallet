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
    // **This is the whole landing for now, on purpose.** BR-001-04's exact
    // words are "routes to onboarding", and #97 (SPEC-020) adds that
    // divergence — first sign-in to the guided flow, returning users straight
    // here. #98 deliberately makes the dashboard everyone's landing first, so
    // the two changes stay separable and the four rules that need a dashboard
    // stop waiting on the onboarding flow to be built.
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
