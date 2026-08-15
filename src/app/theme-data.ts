import { db } from '@/db/client';
import { getEffectiveConfig } from '@/config/effective';
import { tryUserId } from '@/lib/session';
import type { ThemePreference } from '@/components/patterns/theme';

/**
 * AR-31/AR-35: `page.tsx` and `layout.tsx` may not import `@/db/*` — that is a
 * lint rule, not a convention — so the config read lives in this plain `.ts`
 * module and the layout imports only the function.
 *
 * Returns `undefined` for an anonymous visitor rather than the default, and
 * the caller skips rendering `ThemeSync` entirely. The distinction matters:
 * there is no account preference to reconcile against, so overwriting the
 * device's own choice with 'system' would undo it on every page load.
 */
export async function loadThemePreference(): Promise<ThemePreference | undefined> {
  const userId = await tryUserId();
  if (!userId) return undefined;

  const effective = await getEffectiveConfig(db, { userId });
  const entry = effective.find((candidate) => candidate.key === 'ui.theme');

  return entry ? (entry.value as ThemePreference) : 'system';
}
