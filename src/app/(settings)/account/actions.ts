'use server';

import { revalidatePath } from 'next/cache';
import { signOut } from '@/auth';
import { isErr } from '@/core/shared/result';
import { db } from '@/db/client';
import { REGISTRY } from '@/config/registry';
import { setConfigValue } from '@/config/resolve';
import { withTenant } from '@/db/tenant';
import { requireUserId } from '@/lib/session';

/**
 * SPEC-022 BR-022-11 / SPEC-001 BR-001-07 — **Sair.**
 *
 * Auth.js's `signOut` reads the session cookie, calls the adapter's
 * `deleteSession` — which removes the `sessions` row, so a replayed cookie
 * finds nothing to resume — clears the cookie, and redirects to the sign-in
 * page. Clearing the cookie alone would not satisfy BR-001-07.
 *
 * A Server Action, so it is reachable only by a POST from a `<form>`. Nothing
 * that issues a GET — a prefetch, a crawler, a mail client's link preview —
 * can sign anyone out. Auth.js's own `GET /api/auth/signout` renders a
 * confirmation page and changes nothing; the E2E journey asserts that too.
 */
export async function signOutAction(_formData: FormData): Promise<void> {
  await signOut({ redirectTo: '/signin' });
}

export interface SaveThemeState {
  readonly status: 'saved' | 'error';
}

/**
 * SPEC-022 BR-022-30 / DS-29 — the account menu's theme switch persists to the
 * same `ui.theme` key Preferências renders, through the same validated write
 * (`setConfigValue`, BR-002-03/04, with its audit row), so the two surfaces
 * cannot disagree about what the account chose.
 *
 * The switch has already applied the theme on the client before this runs;
 * this is what makes the choice follow the account to a new session. AR-32:
 * the value is validated by the key's own registry schema at the boundary, and
 * identity comes from the session only (AR-12).
 */
export async function saveThemeAction(theme: unknown): Promise<SaveThemeState> {
  const parsed = REGISTRY['ui.theme'].schema.safeParse(theme);
  if (!parsed.success) return { status: 'error' };

  const userId = await requireUserId();
  // AR-11: `config_overrides` is tenant-scoped; the audit read and the upsert
  // share one transaction.
  const result = await withTenant(
    userId,
    (tx) =>
      setConfigValue(tx, {
        key: 'ui.theme',
        level: 'user',
        value: parsed.data,
        actor: { kind: 'user', userId },
        userId,
      }),
    db,
  );
  if (isErr(result)) return { status: 'error' };

  // Every signed-in layout renders `ThemeSync` from the stored value; without
  // this the next navigation could reconcile against the old one.
  revalidatePath('/', 'layout');
  return { status: 'saved' };
}

/**
 * SPEC-022 BR-022-24/25 — the top bar's eye toggle. Writes `ui.hide_values`
 * through the same validated `setConfigValue` as Preferências, so the toggle
 * and the settings screen cannot disagree.
 *
 * A form action rather than a typed call: the toggle is a `<form>` that works
 * before hydration, and masking is applied by the server's next render, which
 * `revalidatePath` asks for. A value that is neither `'true'` nor `'false'`
 * changes nothing — the form only ever sends one of the two.
 */
export async function saveHideValuesAction(formData: FormData): Promise<void> {
  const raw = formData.get('hidden');
  if (raw !== 'true' && raw !== 'false') return;

  const userId = await requireUserId();
  // AR-11, as for the theme above.
  await withTenant(
    userId,
    (tx) =>
      setConfigValue(tx, {
        key: 'ui.hide_values',
        level: 'user',
        value: raw === 'true',
        actor: { kind: 'user', userId },
        userId,
      }),
    db,
  );

  // Every amount on every signed-in screen is rendered from this key.
  revalidatePath('/', 'layout');
}
