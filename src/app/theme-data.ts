import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
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

  /**
   * AR-11. `config_overrides` is tenant-scoped and its RLS policy casts
   * `current_setting('app.user_id')` to uuid; outside a `withTenant`
   * transaction that setting is the empty string, so the read does not fail
   * closed and return nothing — it raises
   * `22P02 invalid input syntax for type uuid: ""`.
   *
   * **This function runs in the root layout, so that error took down every
   * page for every signed-in user.** It was invisible because nothing in any
   * suite had an authenticated session to render with: signed out this
   * returns early on the line above and never touches the table.
   */
  const effective = await withTenant(userId, (tx) => getEffectiveConfig(tx, { userId }), db);
  const entry = effective.find((candidate) => candidate.key === 'ui.theme');

  return entry ? (entry.value as ThemePreference) : 'system';
}
