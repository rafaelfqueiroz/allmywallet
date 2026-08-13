import { eq } from 'drizzle-orm';
import { configOverrides } from '@/db/schema/config';
import { CONFIG_KEYS, registryEntry, type ConfigKey } from '@/config/registry';
import { ConfigValidationError } from '@/config/errors';
import { primeDeploymentCache } from '@/config/resolve';
import type { Tx } from '@/config/tx';

export interface ConfigFailure {
  readonly key: ConfigKey;
  readonly error: ConfigValidationError;
}

/**
 * SPEC-002 BR-002-04 / DL-002-01: checks every key's *currently stored*
 * deployment-level value (or, absent an override, its default) against its
 * own schema. Returns failures rather than exiting, so both the real
 * entrypoints and a test can drive it — `validateConfigOrExit` below is the
 * only thing that actually calls `process.exit`.
 *
 * Deliberately reads `config_overrides` directly rather than going through
 * `resolve.ts`'s cache: this runs *before* the process is considered booted,
 * so it must see the database's current state, not a cache that might be
 * stale from a previous validation attempt.
 */
export async function collectConfigFailures(db: Tx): Promise<readonly ConfigFailure[]> {
  const rows = await db
    .select({ key: configOverrides.key, value: configOverrides.value })
    .from(configOverrides)
    .where(eq(configOverrides.level, 'deployment'));
  const overrides = new Map(rows.map((row) => [row.key, row.value] as const));

  const failures: ConfigFailure[] = [];
  for (const key of CONFIG_KEYS) {
    const entry = registryEntry(key);
    const hasOverride = overrides.has(key);
    const raw = hasOverride ? overrides.get(key) : entry.default;
    const parsed = entry.schema.safeParse(raw);
    if (!parsed.success) {
      failures.push({
        key,
        error: new ConfigValidationError(
          key,
          raw,
          entry.range,
          hasOverride ? 'deployment' : 'default',
          parsed.error,
        ),
      });
    }
  }
  return failures;
}

/**
 * AR-40/AR-41: both `web` (src/instrumentation.ts) and `worker`
 * (src/worker/index.ts#startWorker) call this before accepting a request or
 * a job. BR-002-04: an invalid value fails the boot loudly — the message
 * names the key, the offending value and the permitted range — and never
 * falls back to a default. A cadence of `0` must never be interpreted as
 * "poll continuously" (DL-002-01), so there is no fallback path here at all.
 */
export async function validateConfigOrExit(db: Tx): Promise<void> {
  const failures = await collectConfigFailures(db);
  if (failures.length > 0) {
    for (const failure of failures) {
      // console.error is allowed by lint (boot-time diagnostic, before the
      // logger's transport is necessarily healthy).
      console.error(`[config] ${failure.error.message}`);
    }
    process.exit(1);
  }
  await primeDeploymentCache(db);
}
