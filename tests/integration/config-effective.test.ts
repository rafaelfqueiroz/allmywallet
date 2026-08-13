import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { withTenantContext } from '../support/tenant-context';
import * as schema from '@/db/schema';
import { UserId } from '@/core/shared/ids';
import { CONFIG_KEYS } from '@/config/registry';
import { getEffectiveConfig } from '@/config/effective';
import { setConfigValue, invalidateDeploymentCache } from '@/config/resolve';
import { setRuntimeState } from '@/config/runtime-state';

/**
 * BR-002-09: "The effective configuration — each resolved value and which
 * level supplied it — is inspectable by an operator without reading source."
 * BR-002-08/AR-43: secrets are excluded from any config listing.
 */
describe('SPEC-002 — effective configuration view (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const userA = UserId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: another suite file may have left rows behind when the database
    // is reused rather than created per file.
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);

    pool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    db = drizzle(pool, { schema });
    invalidateDeploymentCache();
  }, 180_000);

  afterAll(async () => {
    // See config-resolve.test.ts's afterAll for why this must close before `testDb.stop()`.
    await pool.end();
    await testDb.stop();
  });

  it('lists every registry key with its resolved value and origin level', async () => {
    const effective = await getEffectiveConfig(db);
    const keys = effective.map((entry) => entry.key);
    expect(new Set(keys)).toEqual(new Set(CONFIG_KEYS));
    for (const entry of effective) {
      expect(['default', 'deployment', 'tenant', 'user', 'runtime']).toContain(entry.source);
    }
  });

  it('an operator-set value shows source "deployment"; an untouched key shows "default"', async () => {
    await setConfigValue(db, {
      key: 'auth.session_idle_days',
      level: 'deployment',
      value: 14,
      actor: { kind: 'operator' },
    });

    const effective = await getEffectiveConfig(db);
    const sessionIdle = effective.find((entry) => entry.key === 'auth.session_idle_days');
    expect(sessionIdle?.value).toBe(14);
    expect(sessionIdle?.source).toBe('deployment');

    const untouched = effective.find((entry) => entry.key === 'retention.audit_months');
    expect(untouched?.source).toBe('default');
  });

  it('a runtime-degraded key is shown with source "runtime" and its reason — never as an operator setting (BR-002-06)', async () => {
    await setRuntimeState(
      db,
      'quotes.cadence_minutes',
      90,
      'cadence degraded: budget alert crossed',
    );

    const effective = await getEffectiveConfig(db);
    const cadence = effective.find((entry) => entry.key === 'quotes.cadence_minutes');
    expect(cadence?.source).toBe('runtime');
    expect(cadence?.reason).toBe('cadence degraded: budget alert crossed');
  });

  it("resolving with a userId also reflects that user's own preference", async () => {
    // TODO(#6): a real user-level write/read happens inside withTenant; until
    // it exists, `withTenantContext` sets the same `app.user_id` a request
    // would, so RLS lets the row through both ways (BR-002-10).
    await withTenantContext(testDb.appUrl, userA, (tx) =>
      setConfigValue(tx, {
        key: 'reports.concentration_threshold_pct',
        level: 'user',
        value: 33,
        actor: { kind: 'user', userId: userA },
        userId: userA,
      }),
    );

    const effective = await withTenantContext(testDb.appUrl, userA, (tx) =>
      getEffectiveConfig(tx, { userId: userA }),
    );
    const threshold = effective.find(
      (entry) => entry.key === 'reports.concentration_threshold_pct',
    );
    expect(threshold?.value).toBe(33);
    expect(threshold?.source).toBe('user');
  });

  it('no secret value or key appears anywhere in the effective-configuration view', async () => {
    const effective = await getEffectiveConfig(db);
    const serialized = JSON.stringify(effective);

    // A real connection string or bearer-token-shaped value must never leak
    // in — this is what AR-43/BR-002-08 actually protects against, since
    // `REGISTRY` (src/config/registry.ts) never declares a secret key in the
    // first place (asserted statically in registry.test.ts).
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toContain(testDb.appUrl);
    expect(serialized).not.toContain(testDb.migrationUrl);
    expect(serialized).not.toMatch(/secret|password|dsn|credential/i);
  });
});
