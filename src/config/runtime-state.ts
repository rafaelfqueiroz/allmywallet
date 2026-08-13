import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Tx } from '@/config/tx';
import { registryEntry, type ConfigKey, type ConfigValue } from '@/config/registry';
import { runtimeState, auditLog } from '@/db/schema/config';

/**
 * SPEC-002 BR-002-05/AR-42: values the system adjusts autonomously, kept in a
 * store an operator-set value can never share. DL-002-02: if a degraded
 * cadence lived in `config_overrides` next to operator config, nobody could
 * tell an intentional setting from an automatic one, and the next deploy
 * would silently revert a degradation the system still needs.
 *
 * SPEC-008 BR-008-22 is the first and, in v1, only consumer: the quote
 * poller writes here when it lengthens its own cadence under budget
 * pressure, and `resolve.ts#resolveConfig` reads here first, ahead of the
 * operator chain, so the degraded value is what actually takes effect.
 */
export interface RuntimeStateRow<K extends ConfigKey = ConfigKey> {
  readonly key: K;
  readonly value: ConfigValue<K>;
  readonly reason: string;
  readonly updatedAt: Date;
}

export async function getRuntimeStateRow<K extends ConfigKey>(
  db: Tx,
  key: K,
): Promise<RuntimeStateRow<K> | undefined> {
  const rows = await db
    .select({
      value: runtimeState.value,
      reason: runtimeState.reason,
      updatedAt: runtimeState.updatedAt,
    })
    .from(runtimeState)
    .where(eq(runtimeState.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { key, value: row.value as ConfigValue<K>, reason: row.reason, updatedAt: row.updatedAt };
}

/**
 * BR-002-06: an autonomous adjustment is never presented as an intentional
 * operator setting — callers write here, never through `setConfigValue`,
 * which is the operator/user path. `reason` is mandatory so the effective-
 * config view (BR-002-09) can always say *why*, not just *what*.
 *
 * A value the system itself produces failing its own registry schema is a
 * genuine bug, not an expected outcome (ARCHITECTURE §9) — `entry.schema.parse`
 * throws rather than returning a `Result`, deliberately, so it surfaces as a
 * fault rather than being swallowed.
 */
export async function setRuntimeState<K extends ConfigKey>(
  db: Tx,
  key: K,
  value: ConfigValue<K>,
  reason: string,
): Promise<void> {
  const entry = registryEntry(key);
  const parsed = entry.schema.parse(value);
  const updatedAt = new Date();

  await db
    .insert(runtimeState)
    .values({ key, value: parsed, reason, updatedAt })
    .onConflictDoUpdate({
      target: runtimeState.key,
      set: { value: parsed, reason, updatedAt },
    });

  // Audited too (BR-002-07 speaks of "configuration changes affecting
  // behaviour" generally, and a cadence degradation is exactly that) — but
  // with actor 'system', which is what lets an operator tell this row apart
  // from one they wrote themselves via `setConfigValue`.
  await db.insert(auditLog).values({
    id: uuidv7(),
    actor: 'system',
    action: 'runtime_state.set',
    entityType: 'runtime_state',
    entityKey: key,
    previousValue: null,
    newValue: { value: parsed, reason },
  });
}

/** Clears a system adjustment — e.g. once the condition that caused it (budget pressure) resolves. */
export async function clearRuntimeState<K extends ConfigKey>(db: Tx, key: K): Promise<void> {
  await db.delete(runtimeState).where(eq(runtimeState.key, key));
}
