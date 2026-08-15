import type { ReactNode } from 'react';
import { AppShell } from '@/components/patterns/app-shell';
import { ThemeSync } from '@/components/patterns/theme';
import { loadThemePreference } from '@/app/theme-data';

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
 */
export async function AuthenticatedFrame({ children }: { children: ReactNode }) {
  const theme = await loadThemePreference();

  return (
    <>
      {theme && <ThemeSync theme={theme} />}
      <AppShell>{children}</AppShell>
    </>
  );
}
