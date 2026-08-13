import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedUser } from '../support/users';
import { withTenantContext } from '../support/tenant-context';
import * as schema from '@/db/schema';
import { UserId } from '@/core/shared/ids';
import { resolveConfig, setConfigValue, invalidateDeploymentCache } from '@/config/resolve';
import { setRuntimeState } from '@/config/runtime-state';

/**
 * TESTING §1: RLS and NUMERIC round-tripping cannot be tested against a
 * mock — but this file's actual job is the *resolution chain itself*
 * (BR-002-02), which happens to need real rows to resolve against. It
 * exercises deployment/tenant/user layers, the runtime-state override
 * (BR-002-05/06, BR-008-22), and that a degradation "survives a redeploy"
 * (simulated here as: process cache invalidated, row still in the table).
 */
describe('SPEC-002 — config resolution (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const userA = UserId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);

    pool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    // Closing our own connection(s) before the container stops avoids an
    // unhandled "terminating connection due to administrator command" error
    // when the container's forced shutdown races an open pg client.
    await pool.end();
    await testDb.stop();
  });

  it('resolves the registry default when nothing overrides the key', async () => {
    invalidateDeploymentCache();
    const resolved = await resolveConfig('reports.concentration_threshold_pct', { db });
    expect(resolved).toEqual({
      key: 'reports.concentration_threshold_pct',
      value: 20,
      source: 'default',
    });
  });

  it('a deployment-level write overrides the default for every subsequent read', async () => {
    invalidateDeploymentCache();
    const write = await setConfigValue(db, {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 45,
      actor: { kind: 'operator' },
    });
    expect(write.ok).toBe(true);

    const resolved = await resolveConfig('quotes.cadence_minutes', { db });
    expect(resolved).toEqual({ key: 'quotes.cadence_minutes', value: 45, source: 'deployment' });
  });

  it('a user-level write overrides deployment for that user only — most specific wins (BR-002-02)', async () => {
    await setConfigValue(db, {
      key: 'import.staleness_days',
      level: 'deployment',
      value: 30,
      actor: { kind: 'operator' },
    });
    // TODO(#6): a real user-level write happens inside withTenant; until it
    // exists, `withTenantContext` (tests/support/tenant-context.ts) sets the
    // same `app.user_id` a request would, so the RLS WITH CHECK (BR-002-10)
    // lets the row through.
    await withTenantContext(testDb.appUrl, userA, (tx) =>
      setConfigValue(tx, {
        key: 'import.staleness_days',
        level: 'user',
        value: 5,
        actor: { kind: 'user', userId: userA },
        userId: userA,
      }),
    );

    const withUser = await withTenantContext(testDb.appUrl, userA, (tx) =>
      resolveConfig('import.staleness_days', { db: tx, userId: userA }),
    );
    expect(withUser).toEqual({ key: 'import.staleness_days', value: 5, source: 'user' });

    const withoutUser = await resolveConfig('import.staleness_days', { db });
    expect(withoutUser).toEqual({ key: 'import.staleness_days', value: 30, source: 'deployment' });
  });

  it('runtime state (SPEC-008 BR-008-22) takes precedence over the operator chain', async () => {
    await setConfigValue(db, {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 30,
      actor: { kind: 'operator' },
    });
    await setRuntimeState(
      db,
      'quotes.cadence_minutes',
      120,
      'cadence degraded: 42 assets exceeds 30min budget',
    );

    const resolved = await resolveConfig('quotes.cadence_minutes', { db });
    expect(resolved.value).toBe(120);
    expect(resolved.source).toBe('runtime');
  });

  it('a runtime-state adjustment survives a simulated redeploy and stays distinguishable from operator config', async () => {
    // "Redeploy" here is simulated the way BR-002-05/AR-42 actually protects
    // against: a fresh deployment-level write (the thing a redeploy would
    // carry) landing in `config_overrides` must not touch `runtime_state` at
    // all — they are physically separate tables.
    await setConfigValue(db, {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 30, // an operator "redeploying" with the original value
      actor: { kind: 'operator' },
    });

    const resolved = await resolveConfig('quotes.cadence_minutes', { db });
    // The runtime-state row from the previous test is untouched — it still wins.
    expect(resolved.value).toBe(120);
    expect(resolved.source).toBe('runtime');
  });
});
