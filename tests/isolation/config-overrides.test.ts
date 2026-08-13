import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedUser } from '../support/users';
import { withTenantContext } from '../support/tenant-context';
import * as schema from '@/db/schema';
import { configOverrides } from '@/db/schema/config';
import { UserId } from '@/core/shared/ids';
import { setConfigValue } from '@/config/resolve';

/**
 * TESTING §4 — the blocking gate. `config_overrides` is the one tenant-scoped
 * table this dispatch introduces (BR-002-10: per-user preferences are tenant
 * data). `runtime_state` and `audit_log` are deliberately not tenant-scoped
 * (see src/db/schema/config.ts) and are out of this gate's scope.
 *
 * TODO(#6): `withTenantContext` (tests/support/tenant-context.ts) stands in
 * for the real `withTenant` until it exists.
 */
describe('SPEC-002 — config_overrides tenant isolation', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;
  const userA = UserId.generate();
  const userB = UserId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    // Seed distinguishable user-level rows for both tenants, as each tenant
    // themselves — TS-15's standard shape.
    await withTenantContext(testDb.appUrl, userA, (tx) =>
      setConfigValue(tx, {
        key: 'reports.concentration_threshold_pct',
        level: 'user',
        value: 11,
        actor: { kind: 'user', userId: userA },
        userId: userA,
      }),
    );
    await withTenantContext(testDb.appUrl, userB, (tx) =>
      setConfigValue(tx, {
        key: 'reports.concentration_threshold_pct',
        level: 'user',
        value: 99,
        actor: { kind: 'user', userId: userB },
        userId: userB,
      }),
    );
    // A global, deployment-level row too — must remain visible to everyone.
    await setConfigValue(migratorDb, {
      key: 'auth.session_idle_days',
      level: 'deployment',
      value: 20,
      actor: { kind: 'operator' },
    });
  }, 180_000);

  afterAll(async () => {
    // See tests/integration/config-resolve.test.ts's afterAll for why this
    // must close before `testDb.stop()`.
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it("as tenant A, reading config_overrides returns only tenant A's user-level row and the global deployment row — nothing of B's", async () => {
    const rows = await withTenantContext(testDb.appUrl, userA, (tx) =>
      tx.select().from(configOverrides),
    );

    const userRows = rows.filter((r) => r.level === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.userId).toBe(userA);
    expect(userRows[0]?.value).toBe(11);
    expect(rows.some((r) => r.userId === userB)).toBe(false);

    const deploymentRows = rows.filter((r) => r.level === 'deployment');
    expect(deploymentRows).toHaveLength(1);
  });

  it("as tenant B, reading config_overrides returns only tenant B's row — nothing of A's", async () => {
    const rows = await withTenantContext(testDb.appUrl, userB, (tx) =>
      tx.select().from(configOverrides),
    );

    const userRows = rows.filter((r) => r.level === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.userId).toBe(userB);
    expect(userRows[0]?.value).toBe(99);
    expect(rows.some((r) => r.userId === userA)).toBe(false);
  });

  it('tenant A cannot write a row attributed to tenant B, even when explicitly requesting userId B (WITH CHECK, not just USING)', async () => {
    await expect(
      withTenantContext(testDb.appUrl, userA, (tx) =>
        tx.insert(configOverrides).values({
          id: '01936b0a-0000-7000-8000-0000000000ff',
          key: 'import.reminder_enabled',
          level: 'user',
          userId: userB,
          value: true,
        }),
      ),
    ).rejects.toThrow();
  });

  it("a query with no tenant context set (outside withTenant) never returns another tenant's user-level rows — only the global, non-tenant rows", async () => {
    // TS-16, adapted: this table intentionally mixes global rows (needed for
    // deployment-level resolution with no session at all, see the migration
    // file's header) with tenant rows. Without app.user_id set, the policy's
    // `current_setting(..., true)` returns NULL, so `user_id = NULL` never
    // matches any user-level row — the query returns the global rows only,
    // never "everything" and never another tenant's data.
    const rows = await appDb.select().from(configOverrides);
    expect(rows.every((r) => r.level !== 'user')).toBe(true);
    expect(rows.some((r) => r.level === 'deployment')).toBe(true);
  });

  it('the application role cannot bypass RLS (TS-18)', async () => {
    const result = await migratorDb.execute(
      sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'allmywallet_app'`,
    );
    const row = result.rows[0] as { rolbypassrls: boolean } | undefined;
    expect(row?.rolbypassrls).toBe(false);
  });

  it('config_overrides has ROW LEVEL SECURITY enabled and forced', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'config_overrides'`,
    );
    const row = result.rows[0] as
      { relrowsecurity: boolean; relforcerowsecurity: boolean } | undefined;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });

  it('a tenant cannot write a deployment-level row — BR-002-03 at the RLS floor', async () => {
    // BR-002-03 calls level enforcement "a tenant-isolation concern, not just
    // validation". `authorizeConfigWrite` refuses this in application code; this
    // asserts the database refuses it too, so a bug or a new call path that
    // skips that check cannot let a user write global operator configuration.
    //
    // 42501 = insufficient_privilege, raised by the policy's WITH CHECK.
    await expect(
      withTenantContext(testDb.appUrl, userA, async (tx) =>
        tx.execute(
          sql`INSERT INTO config_overrides (id, key, level, user_id, value)
              VALUES (gen_random_uuid(), 'quotes.cadence_minutes', 'deployment', NULL, '45'::jsonb)`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a tenant cannot smuggle a row in under another tenant’s id', async () => {
    // The WITH CHECK half of tenant_isolation. Without it, a read-side test
    // would still pass while A quietly wrote rows attributed to B.
    await expect(
      withTenantContext(testDb.appUrl, userA, async (tx) =>
        tx.execute(
          sql`INSERT INTO config_overrides (id, key, level, user_id, value)
              VALUES (gen_random_uuid(), 'reports.default_grouping', 'user', ${userB}::uuid, '"asset_class"'::jsonb)`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
