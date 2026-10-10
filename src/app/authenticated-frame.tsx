import type { ReactNode } from 'react';
import { AppShell } from '@/components/patterns/app-shell';
import { AccountMenu } from '@/components/patterns/account-menu';
import { ThemeSync } from '@/components/patterns/theme';
import { loadThemePreference } from '@/app/theme-data';
import { loadAccountProfile } from '@/app/account-profile';
import { reopenOnboardingAction } from '@/app/(app)/onboarding/actions';
import { saveThemeAction, signOutAction } from '@/app/(settings)/account/actions';
import { loadFailedBackup } from '@/app/backup-status';
import { BackupNotice } from '@/app/backup-notice';

/**
 * What every signed-in route group renders around its pages: the navigation
 * frame with its top bar, and the reconciliation of the account's stored theme
 * with whatever this device guessed before paint.
 *
 * It lives here rather than in the root layout on purpose (DS-40). Reading the
 * session opts a layout into dynamic rendering, and doing that at the root took
 * `/` and `/signin` — the two pages that should be prerendered — with it.
 *
 * The `(auth)` group deliberately does not use this: a sign-in page with an
 * application menu offers navigation to someone who cannot yet navigate.
 *
 * SPEC-022 BR-022-09/10/11 — this is the one place `app/` meets the account
 * menu: the Google profile, the stored theme, Sair, the theme save and the
 * guide's help entry (SPEC-020 BR-020-13) are all threaded in as props, so
 * `AppShell` and `AccountMenu` stay free of Auth.js, registry and onboarding
 * imports (DS-02).
 *
 * **No account menu for a signed-out visitor.** Every page inside these groups
 * renders regardless of session — `/wallets` and `/dashboard` show their own
 * "sign in to continue" state rather than the whole group redirecting (AR-12:
 * no protected surface *relies* on the middleware's cookie-presence check) —
 * and each of the menu's actions calls `requireUserId()`, which throws rather
 * than returning nothing.
 */
export async function AuthenticatedFrame({ children }: { children: ReactNode }) {
  const [theme, profile, failedBackup] = await Promise.all([
    loadThemePreference(),
    loadAccountProfile(),
    loadFailedBackup(),
  ]);

  return (
    <>
      {theme && <ThemeSync theme={theme} />}
      <AppShell
        account={
          profile ? (
            <AccountMenu
              profile={profile}
              theme={theme ?? 'system'}
              saveTheme={saveThemeAction}
              signOutAction={signOutAction}
              helpAction={reopenOnboardingAction}
            />
          ) : undefined
        }
      >
        {/* SPEC-021 BR-021-20: shown on every signed-in screen until a backup succeeds. */}
        {failedBackup && <BackupNotice failure={failedBackup} />}
        {children}
      </AppShell>
    </>
  );
}
