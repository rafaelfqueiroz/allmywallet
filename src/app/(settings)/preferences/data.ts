import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { getEffectiveConfig, type EffectiveConfigEntry } from '@/config/effective';
import { USER_SETTABLE_KEYS, type ConfigKey } from '@/config/registry';
import { trySessionUserId } from '@/app/(settings)/preferences/session';

/**
 * AR-31: Server Components call a use case in `core/` (or, for this
 * cross-cutting spec, `src/config/`) directly — never the database. That is
 * enforced by lint for `.tsx` files (AR-35's block in eslint.config.mjs), so
 * the `@/db/*` import lives in this plain `.ts` module and `page.tsx` only
 * ever imports the function below.
 */
export async function loadUserSettablePreferences(): Promise<
  readonly EffectiveConfigEntry<ConfigKey>[]
> {
  const userId = trySessionUserId();

  /**
   * AR-11, and it bites hard here. `config_overrides` is tenant-scoped and its
   * RLS policy casts `current_setting('app.user_id')` to uuid. Outside a
   * `withTenant` transaction that setting is the empty string, so the policy
   * does not fail closed and return nothing — it raises
   * `22P02 invalid input syntax for type uuid: ""` and takes the whole page
   * down with a 500.
   *
   * Signed **out** there is no user id, no override read, and no crash — which
   * is exactly why every existing check passed: nothing in the suite had an
   * authenticated session to render with until `tests/e2e/support/authenticated.ts`.
   */
  const effective =
    userId === undefined
      ? await getEffectiveConfig(db, {})
      : await withTenant(userId, (tx) => getEffectiveConfig(tx, { userId }), db);

  return effective.filter((entry) => USER_SETTABLE_KEYS.includes(entry.key));
}
