import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { type TwoTenantFixture, seedTwoTenants, teardownTwoTenants } from './harness';

/**
 * TS-15 standard shape, proven against `withTenant` and the standard policy
 * (`src/db/rls.ts`) directly, since #4/#6 introduce no real tenant-scoped
 * table yet (`users`/`sessions`/`accounts`/`verification_tokens` are all
 * declared-exempt auth substrate — see `tests/isolation/enumeration.test.ts`
 * and `src/db/shared-tables.ts`). The harness scratch table
 * (`tests/isolation/harness.ts`) is wired up with the exact same
 * `tenantIsolationPolicySql` a real migration uses, so this is a genuine
 * proof of the mechanism, not a test of a simplified stand-in.
 */
describe('two-tenant isolation via withTenant (SPEC-003, TS-15/TS-16)', () => {
  let testDb: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let fixture: TwoTenantFixture;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    migratorPool = new Pool({ connectionString: testDb.migrationUrl });
    appPool = new Pool({ connectionString: testDb.appUrl });
    appDb = drizzle(appPool, { schema });

    fixture = await seedTwoTenants(appDb, migratorPool, 'two_tenant');
  }, 180_000);

  afterAll(async () => {
    await teardownTwoTenants(migratorPool, fixture);
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it("a query with no WHERE user_id, as tenant A, returns only tenant A's rows", async () => {
    const rows = await withTenant(
      UserId.of(fixture.tenantAId),
      async (tx) => {
        const result = await tx.execute<{ label: string }>(
          sql`SELECT label FROM ${sql.raw(fixture.table)}`,
        );
        return result.rows;
      },
      appDb,
    );
    expect(rows.map((r) => r.label).sort()).toEqual(['a-row-1', 'a-row-2']);
  });

  it("as tenant B, the same unfiltered query never surfaces tenant A's rows", async () => {
    const rows = await withTenant(
      UserId.of(fixture.tenantBId),
      async (tx) => {
        const result = await tx.execute<{ label: string }>(
          sql`SELECT label FROM ${sql.raw(fixture.table)}`,
        );
        return result.rows;
      },
      appDb,
    );
    expect(rows.map((r) => r.label)).toEqual(['b-row-1']);
  });

  it('WITH CHECK refuses an insert attributed to another tenant (AR-14)', async () => {
    // Drizzle wraps the driver error in DrizzleQueryError, whose own .message
    // is just "Failed query: ..." — the real Postgres error text (what this
    // test actually cares about) is on .cause.
    let error: unknown;
    try {
      await withTenant(
        UserId.of(fixture.tenantAId),
        async (tx) => {
          // As tenant A, but the row claims to belong to tenant B.
          await tx.execute(
            sql`INSERT INTO ${sql.raw(fixture.table)} (id, user_id, label)
                VALUES (${crypto.randomUUID()}, ${fixture.tenantBId}, 'attributed-to-b-by-a')`,
          );
        },
        appDb,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/row-level security/i);
  });

  it('a query issued outside withTenant fails rather than returning everything (TS-16)', async () => {
    // A dedicated, never-before-used connection: on a connection that has
    // *never* called set_config('app.user_id', ...), Postgres has no
    // placeholder for the custom GUC at all, so current_setting raises
    // "unrecognized configuration parameter" — the cleanest demonstration of
    // AR-11's "fails rather than returns everything".
    //
    // A connection pulled from `appPool` after other tests in this file have
    // already run `withTenant` on it would show a *different* failure
    // instead: the transaction-scoped set_config (AR-13's `true` argument)
    // reverts on commit, but it also registers the placeholder for the rest
    // of that connection's life, so current_setting then resolves to '' —
    // which still fails (here, a uuid cast error; on a text-typed user_id
    // column it would instead be an empty *result*, DL-003-01's stated
    // worst case) but with different wording. Both are "fails closed"; a
    // fresh connection is used here so the assertion is exact rather than a
    // regex loose enough to cover both wordings.
    const freshPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    try {
      await expect(freshPool.query(`SELECT label FROM ${fixture.table}`)).rejects.toThrow(
        /unrecognized configuration parameter.*app\.user_id/i,
      );
    } finally {
      await freshPool.end();
    }
  });
});
