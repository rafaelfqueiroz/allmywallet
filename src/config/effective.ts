import type { UserId } from '@/core/shared/ids';
import { CONFIG_KEYS, registryEntry, type ConfigKey, type ConfigLevel } from '@/config/registry';
import { resolveConfig } from '@/config/resolve';
import { getRuntimeStateRow } from '@/config/runtime-state';
import type { Tx } from '@/config/tx';

/**
 * SPEC-002 BR-002-09: the resolved value of every key plus which level
 * supplied it, inspectable by an operator without reading source. AR-43 /
 * BR-002-08: nothing here can ever include a secret, because `REGISTRY`
 * (src/config/registry.ts) never contains one — secrets live only in
 * `src/lib/env.ts` and this module never imports it.
 */
export interface EffectiveConfigEntry<K extends ConfigKey = ConfigKey> {
  readonly key: K;
  readonly value: unknown;
  readonly source: ConfigLevel | 'default' | 'runtime';
  /** Present only when `source === 'runtime'` — BR-002-06: never presented as an operator-intentional setting. */
  readonly reason?: string;
  readonly description: string;
  readonly levels: readonly ConfigLevel[];
}

/**
 * `userId` omitted → the deployment-wide view (what a fresh request with no
 * session would see). `userId` supplied → also resolves that account's
 * tenant/user overrides, for support/debugging a single user's effective
 * configuration.
 *
 * TODO(#6): a `userId`-scoped call must be given the transaction `withTenant`
 * produces for that user, per `resolve.ts`'s `Tx` doc comment — this function
 * does not itself set tenant context.
 */
export async function getEffectiveConfig(
  db: Tx,
  options: { readonly userId?: UserId } = {},
): Promise<readonly EffectiveConfigEntry[]> {
  const entries: EffectiveConfigEntry[] = [];

  for (const key of CONFIG_KEYS) {
    const entry = registryEntry(key);
    const resolved = await resolveConfig(key, {
      db,
      ...(options.userId ? { userId: options.userId } : {}),
    });

    const runtime = resolved.source === 'runtime' ? await getRuntimeStateRow(db, key) : undefined;

    entries.push({
      key,
      value: resolved.value,
      source: resolved.source,
      ...(runtime ? { reason: runtime.reason } : {}),
      description: entry.description,
      levels: entry.levels,
    });
  }

  return entries;
}
