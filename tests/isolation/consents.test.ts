import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConsents, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { consents } from '@/db/schema/privacy';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';

/**
 * TS-13/TS-15 — `consents` (SPEC-004, #7) is a tenant-scoped table; the
 * enumeration gate (`tests/isolation/enumeration.test.ts`) blocks a merge
 * until it is named by an isolation test with its own coverage. This is that
 * test.
 *
 * A consent row states what a person has and has not opted into — worth the
 * same "no shortcuts" treatment `wallets.test.ts`/`positions` isolation tests
 * give their own tables.
 */
describe('SPEC-004 — consents tenant isolation', () => {
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
    // TS-03: CI runs these suites against one shared Postgres service container.
    await resetConsents(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(consents).values({
          id: randomUUID(),
          userId: userA,
          purpose: 'email_reminders',
          grantedAt: new Date('2026-01-01T00:00:00Z'),
          revokedAt: null,
          policyVersion: 'v1',
        });
      },
      appDb,
    );
    await withTenant(
      userB,
      async (tx) => {
        await tx.insert(consents).values({
          id: randomUUID(),
          userId: userB,
          purpose: 'product_analytics',
          grantedAt: new Date('2026-02-01T00:00:00Z'),
          revokedAt: null,
          policyVersion: 'v1',
        });
      },
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    // TS-03/TS-33/TS-34: clean up so a later file's enumeration/isolation
    // suite never inherits these rows.
    await resetConsents(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered consents read returns only A’s row', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(consents), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('email_reminders');
    expect(rows.some((row) => row.purpose === 'product_analytics')).toBe(false);
  });

  it('as tenant B, an unfiltered consents read returns only B’s row', async () => {
    const rows = await withTenant(userB, async (tx) => tx.select().from(consents), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('product_analytics');
  });

  it('an aggregate over consents cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM consents`),
      appDb,
    );
    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  it('tenant A cannot insert a consent attributed to tenant B (42501 — the WITH CHECK half of the policy)', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(consents).values({
            id: randomUUID(),
            userId: userB,
            purpose: 'product_analytics',
            grantedAt: new Date(),
            revokedAt: null,
            policyVersion: 'v1',
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(consents)).rejects.toThrow();
  });

  it('has ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname = 'consents' AND relnamespace = 'public'::regnamespace`,
    );
    const row = result.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it('deleting the tenant root removes the consent row too, so account deletion is complete (AR-27)', async () => {
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);

    await withTenant(
      doomed,
      async (tx) => {
        await tx.insert(consents).values({
          id: randomUUID(),
          userId: doomed,
          purpose: 'email_reminders',
          grantedAt: new Date(),
          revokedAt: null,
          policyVersion: 'v1',
        });
      },
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows } = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM consents WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
