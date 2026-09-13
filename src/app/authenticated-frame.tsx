import type { ReactNode } from 'react';
import { AppShell } from '@/components/patterns/app-shell';
import { ThemeSync } from '@/components/patterns/theme';
import { loadThemePreference } from '@/app/theme-data';
import { reopenOnboardingAction } from '@/app/(app)/onboarding/actions';
import { tryUserId } from '@/lib/session';

/**
 * What every signed-in route group renders around its pages: the navigation
 * frame, and the reconciliation of the account's stored theme with whatever
 * this device guessed before paint.
 *
 * It lives here rather than in the root layout on purpose. Reading the session
 * opts a layout into dynamic rendering, and doing that at the root took `/`
 * and `/signin` — the two pages that should be prerendered — with it.
 *
 * The `(auth)` group deliberately does not use this: a sign-in page with an
 * application menu offers navigation to someone who cannot yet navigate.
 *
 * SPEC-020 BR-020-13 — `reopenOnboardingAction` is threaded into `AppShell` as
 * `helpAction` here, the one place `app/` and the design-system pattern meet.
 * `AppShell` itself stays free of any onboarding import (DS-02).
 *
 * **`helpAction` is `undefined` for a signed-out visitor.** Every page inside
 * this `(app)` group renders regardless of session — `/wallets` and
 * `/dashboard` show their own "sign in to continue" state rather than the
 * whole group redirecting (AR-12: no protected surface *relies* on the
 * middleware's cookie-presence check) — but `AppShell` itself has no such
 * gate, so without this the help button would render for a visitor with no
 * session, and submitting it would call `reopenOnboardingAction`'s
 * `requireUserId()`, which throws rather than returning nothing. `tryUserId()`
 * is already paid for on this exact line by `loadThemePreference` below, so
 * gating on it here costs nothing further.
 */
export async function AuthenticatedFrame({ children }: { children: ReactNode }) {
  const [theme, userId] = await Promise.all([loadThemePreference(), tryUserId()]);

  return (
    <>
      {theme && <ThemeSync theme={theme} />}
      <AppShell helpAction={userId ? reopenOnboardingAction : undefined}>{children}</AppShell>
    </>
  );
}
