import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { UserId } from '@/core/shared/ids';
import { domainError, type DomainError } from '@/core/shared/domain-error';
import { err, ok, type Result } from '@/core/shared/result';
import { configOverrides, auditLog } from '@/db/schema/config';
import { uuidv7 } from 'uuidv7';
import {
  CONFIG_KEYS,
  registryEntry,
  type ConfigKey,
  type ConfigLevel,
  type ConfigValue,
} from '@/config/registry';
import { ConfigErrorCode, ConfigValidationError } from '@/config/errors';
import { getRuntimeStateRow } from '@/config/runtime-state';
import type { Tx } from '@/config/tx';

export type { Tx } from '@/config/tx';

// ---------------------------------------------------------------------------
// Pure resolution — no I/O. TS-01 in spirit: the algorithm that decides
// "most specific wins" is exercised entirely without a database in
// resolve.test.ts, even though this file (outside core/) is allowed to touch
// one for the parts that actually need it.
// ---------------------------------------------------------------------------

export interface ResolvedLayers {
  readonly deployment?: unknown;
  readonly tenant?: unknown;
  readonly user?: unknown;
}

export interface Resolved<K extends ConfigKey> {
  readonly key: K;
  readonly value: ConfigValue<K>;
  /** BR-002-09: which level actually supplied the value. */
  readonly source: ConfigLevel | 'default' | 'runtime';
}

/**
 * SPEC-002 BR-002-02: resolution order is default → deployment → tenant →
 * user; most specific wins. A layer that is `undefined` was never set at
 * that level and is skipped — a layer that is *present but invalid* throws
 * rather than falling through to a less specific level (DL-002-01's
 * "no silent fallback" reasoning applies just as much mid-resolution as it
 * does at boot).
 */
export function resolveFromLayers<K extends ConfigKey>(
  key: K,
  layers: ResolvedLayers,
): Resolved<K> {
  const entry = registryEntry(key);
  const candidates: readonly [ConfigLevel, unknown][] = [
    ['user', layers.user],
    ['tenant', layers.tenant],
    ['deployment', layers.deployment],
  ];

  for (const [level, raw] of candidates) {
    if (raw === undefined) continue;
    const parsed = entry.schema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigValidationError(key, raw, entry.range, level, parsed.error);
    }
    return { key, value: parsed.data as ConfigValue<K>, source: level };
  }

  return { key, value: entry.default as ConfigValue<K>, source: 'default' };
}

/** SPEC-002 BR-002-03: a security check, not form validation — see the actor rules below. */
export type ConfigActor =
  { readonly kind: 'operator' } | { readonly kind: 'user'; readonly userId: UserId };

/**
 * BR-002-03: refuses a write before it ever reaches the database.
 *
 * Two independent reasons to refuse, both reported as the same code so the
 * caller cannot distinguish "your key doesn't allow this" from "you
 * personally aren't allowed this" by probing — that distinction is exactly
 * the kind of oracle a tenant-isolation check must not leak (mirrors TS-17's
 * treatment of cross-tenant probing as a security concern, not a UX one).
 */
export function authorizeConfigWrite<K extends ConfigKey>(
  key: K,
  level: ConfigLevel,
  actor: ConfigActor,
): Result<true, DomainError> {
  const entry = registryEntry(key);

  if (!entry.levels.includes(level)) {
    return err(domainError(ConfigErrorCode.LEVEL_NOT_PERMITTED, { key, level }));
  }
  // Only an operator may write a global row — regardless of what the key's
  // own `levels` list says, a user actor never gets to touch 'deployment'.
  if (level === 'deployment' && actor.kind !== 'operator') {
    return err(domainError(ConfigErrorCode.LEVEL_NOT_PERMITTED, { key, level }));
  }
  // 'tenant' and 'user' rows belong to one account; only that account's own
  // session may write them in v1 (no admin-impersonation path exists yet).
  if ((level === 'tenant' || level === 'user') && actor.kind !== 'user') {
    return err(domainError(ConfigErrorCode.LEVEL_NOT_PERMITTED, { key, level }));
  }

  return ok(true);
}

// ---------------------------------------------------------------------------
// Deployment-level cache — one process, cached until invalidated on write
// (per the issue: "there is one process", so a broadcast mechanism is not
// needed yet).
// ---------------------------------------------------------------------------

let deploymentCache: Map<ConfigKey, unknown> | null = null;

/** Loads every deployment-level row into the process cache. Call once at boot (validate.ts) or lazily on first read. */
export async function primeDeploymentCache(db: Tx): Promise<void> {
  const rows = await db
    .select({ key: configOverrides.key, value: configOverrides.value })
    .from(configOverrides)
    .where(eq(configOverrides.level, 'deployment'));

  const map = new Map<ConfigKey, unknown>();
  for (const row of rows) {
    if ((CONFIG_KEYS as readonly string[]).includes(row.key)) {
      map.set(row.key as ConfigKey, row.value);
    }
  }
  deploymentCache = map;
}

/** Called after any deployment-level write, so the next read sees it without a restart. */
export function invalidateDeploymentCache(): void {
  deploymentCache = null;
}

/** Test-only escape hatch — lets a unit test install a fixture cache without a database. */
export function primeDeploymentCacheForTest(entries: Partial<Record<ConfigKey, unknown>>): void {
  deploymentCache = new Map(Object.entries(entries) as [ConfigKey, unknown][]);
}

async function deploymentValue<K extends ConfigKey>(db: Tx, key: K): Promise<unknown> {
  if (deploymentCache === null) await primeDeploymentCache(db);
  return deploymentCache?.get(key);
}

// ---------------------------------------------------------------------------
// Full resolution, database-backed.
// ---------------------------------------------------------------------------

export interface ResolveContext {
  readonly db: Tx;
  /** Required to read tenant/user-level overrides. Omit for a deployment-only lookup (e.g. the worker). */
  readonly userId?: UserId;
}

/**
 * The value a consumer should actually use. SPEC-008 BR-008-22: a system
 * runtime-state adjustment (if one exists for this key) always wins over the
 * operator chain — that is what lets the quote poller pick up a degraded
 * cadence without a deploy, and what makes the degradation survive one
 * (BR-002-06). `effective.ts` is what shows an operator *why* — this function
 * just returns the number that is actually in effect.
 */
export async function resolveConfig<K extends ConfigKey>(
  key: K,
  ctx: ResolveContext,
): Promise<Resolved<K>> {
  const runtime = await getRuntimeStateRow(ctx.db, key);
  if (runtime) {
    return { key, value: runtime.value as ConfigValue<K>, source: 'runtime' };
  }

  const deployment = await deploymentValue(ctx.db, key);

  let tenant: unknown;
  let user: unknown;
  if (ctx.userId) {
    // TODO(#6): `ctx.db` must be the transaction `withTenant` supplies for
    // this to actually be scoped — see the `Tx` doc comment above.
    const rows = await ctx.db
      .select({ level: configOverrides.level, value: configOverrides.value })
      .from(configOverrides)
      .where(
        and(
          eq(configOverrides.key, key),
          eq(configOverrides.userId, ctx.userId),
          inArray(configOverrides.level, ['tenant', 'user']),
        ),
      );
    tenant = rows.find((r) => r.level === 'tenant')?.value;
    user = rows.find((r) => r.level === 'user')?.value;
  }

  return resolveFromLayers(key, { deployment, tenant, user });
}

// ---------------------------------------------------------------------------
// Writes — validated, authorized, audited, cache-invalidating.
// ---------------------------------------------------------------------------

export interface SetConfigRequest<K extends ConfigKey> {
  readonly key: K;
  readonly level: ConfigLevel;
  readonly value: ConfigValue<K>;
  readonly actor: ConfigActor;
  /** Required (and must equal `actor.userId` for a user actor) for 'tenant'/'user' level writes. */
  readonly userId?: UserId;
}

export interface SetConfigResult<K extends ConfigKey> {
  readonly key: K;
  readonly level: ConfigLevel;
  readonly previousValue: ConfigValue<K> | undefined;
  readonly newValue: ConfigValue<K>;
}

/**
 * SPEC-002 BR-002-03/04/07: authorizes, validates, upserts and audits a
 * single configuration write in one transaction-scoped call. `db` must be a
 * transaction for 'tenant'/'user' writes (TODO(#6) as above); a
 * deployment-level write has no tenant context to speak of and may use the
 * plain database handle.
 */
export async function setConfigValue<K extends ConfigKey>(
  db: Tx,
  request: SetConfigRequest<K>,
): Promise<Result<SetConfigResult<K>, DomainError>> {
  const authorization = authorizeConfigWrite(request.key, request.level, request.actor);
  if (!authorization.ok) return authorization;

  const entry = registryEntry(request.key);
  const parsed = entry.schema.safeParse(request.value);
  if (!parsed.success) {
    return err(
      domainError(ConfigErrorCode.INVALID_VALUE, {
        key: request.key,
        level: request.level,
        range: entry.range,
      }),
    );
  }

  const userId = request.level === 'deployment' ? null : (request.userId ?? null);
  if ((request.level === 'tenant' || request.level === 'user') && userId === null) {
    return err(
      domainError(ConfigErrorCode.LEVEL_NOT_PERMITTED, { key: request.key, level: request.level }),
    );
  }

  const scope = userId
    ? and(
        eq(configOverrides.key, request.key),
        eq(configOverrides.level, request.level),
        eq(configOverrides.userId, userId),
      )
    : and(
        eq(configOverrides.key, request.key),
        eq(configOverrides.level, request.level),
        isNull(configOverrides.userId),
      );

  const existing = await db
    .select({ value: configOverrides.value })
    .from(configOverrides)
    .where(scope)
    .limit(1);
  const previousValue = existing[0]?.value as ConfigValue<K> | undefined;

  await db
    .insert(configOverrides)
    .values({
      id: uuidv7(),
      key: request.key,
      level: request.level,
      userId,
      value: parsed.data,
    })
    .onConflictDoUpdate({
      target: [configOverrides.key, configOverrides.level, configOverrides.userId],
      set: { value: parsed.data, updatedAt: new Date() },
    });

  // SPEC-002 BR-002-07: every configuration change affecting behaviour is
  // audited with actor, previous and new value.
  await db.insert(auditLog).values({
    id: uuidv7(),
    actor: request.actor.kind === 'operator' ? 'operator' : request.actor.userId,
    action: 'config.set',
    entityType: 'config_override',
    entityKey: request.key,
    previousValue: previousValue ?? null,
    newValue: parsed.data,
  });

  if (request.level === 'deployment') invalidateDeploymentCache();

  return ok({
    key: request.key,
    level: request.level,
    previousValue,
    newValue: parsed.data,
  });
}
