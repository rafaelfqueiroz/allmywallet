import { useTranslations } from 'next-intl';
import { signIn } from '@/auth';

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
    await signIn('google', { redirectTo: '/' });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
      <form action={signInWithGoogle} className="w-full">
        <button
          type="submit"
          className="w-full rounded-md bg-foreground px-4 py-2 font-medium text-background"
        >
          {t('googleButton')}
        </button>
      </form>
      {/* BR-001-12 acceptance criterion: stated on the sign-up screen itself. */}
      <p className="text-sm text-muted-foreground">{t('noRecoveryNotice')}</p>
    </main>
  );
}
