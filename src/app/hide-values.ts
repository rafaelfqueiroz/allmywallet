import { cache, use } from 'react';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { getEffectiveConfig } from '@/config/effective';
import { tryUserId } from '@/lib/session';

/**
 * SPEC-022 BR-022-25 / DL-022-06 — whether this request renders money amounts.
 *
 * The preference is read **on the server, per request**, so a masked amount is
 * never in the HTML at all: not painted before hydration, and not sitting in
 * the markup behind a CSS rule either.
 *
 * `cache` makes it one read per request however many amounts the page renders.
 * Layouts and pages render in parallel, and a client-side navigation re-renders
 * the page without its layout, so the frame cannot hand the value down — every
 * reader asks for it, and the first one pays.
 *
 * A visitor with no session sees nothing masked: there is no account whose
 * preference this is, and every authenticated page shows its own sign-in state.
 */
export const loadHideValues = cache(async (): Promise<boolean> => {
  const userId = await tryUserId();
  if (!userId) return false;

  // AR-11 — see `theme-data.ts` for what this read does outside `withTenant`.
  const effective = await withTenant(userId, (tx) => getEffectiveConfig(tx, { userId }), db);
  return effective.find((entry) => entry.key === 'ui.hide_values')?.value === true;
});

/**
 * The same read for a synchronous Server Component — `Money` above all, which
 * is rendered from deep inside tables and cards that are not async.
 */
export function useHideValues(): boolean {
  return use(loadHideValues());
}
