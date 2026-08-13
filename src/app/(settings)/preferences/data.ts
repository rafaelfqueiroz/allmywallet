import { db } from '@/db/client';
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
  const effective = await getEffectiveConfig(db, userId ? { userId } : {});
  return effective.filter((entry) => USER_SETTABLE_KEYS.includes(entry.key));
}
