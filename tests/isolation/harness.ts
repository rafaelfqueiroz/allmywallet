import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from '@/db/schema';
import { users } from '@/db/schema/users';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { tenantIsolationPolicySql } from '@/db/rls';

/**
 * The two-tenant fixture (TS-15) and the scratch-table RLS proof used by
 * `tests/isolation/two-tenant-rls.test.ts` and this directory's meta-tests.
 *
 * Table enumeration itself (TS-13 — "every non-shared table carries
 * `user_id`, has `FORCE` RLS, and a `USING`+`WITH CHECK` policy") lives in
 * `tests/isolation/enumeration.test.ts`, not here — keeping one canonical
 * enumeration mechanism rather than two that could silently disagree.
 */

export const RLS_HARNESS_TABLE_PREFIX = '_rls_harness_';

/**
 * Creates a throwaway tenant-scoped table, wired up exactly as AR-14
 * prescribes (via `tenantIsolationPolicySql`, the same helper a real
 * migration uses), so the RLS *mechanism* can be proven correct against real
 * Postgres before any real tenant-scoped table exists yet in this migration
 * set (#4/#6 introduce none — `users`/`sessions`/`accounts`/
 * `verification_tokens` are all declared-exempt auth substrate). Table names
 * are prefixed so `isSharedTable` (`src/db/shared-tables.ts`) — and
 * therefore the enumeration gate itself — never mistakes a fixture for a
 * real tenant table.
 */
export async function createRlsHarnessTable(migratorPool: Pool, name: string): Promise<string> {
  const table = `${RLS_HARNESS_TABLE_PREFIX}${name}`;
  // TS-03: every test is independent. Dropping first matters only when the
  // database outlives the run — a CI service container, or a crashed suite that
  // never reached its teardown. With a fresh Testcontainer per file the
  // collision is invisible, which is exactly why it reached CI.
  await migratorPool.query(`DROP TABLE IF EXISTS ${table}`);
  await migratorPool.query(`
    CREATE TABLE ${table} (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label text NOT NULL
    )
  `);
  await migratorPool.query(tenantIsolationPolicySql(table));
  return table;
}

export async function dropRlsHarnessTable(migratorPool: Pool, table: string): Promise<void> {
  await migratorPool.query(`DROP TABLE IF EXISTS ${table}`);
}

export interface TwoTenantFixture {
  readonly table: string;
  readonly tenantAId: string;
  readonly tenantBId: string;
}

/**
 * TS-15 standard shape: seeds two distinguishable tenants (A/B), each with
 * their own rows in a throwaway RLS-protected scratch table.
 *
 * Seeded *through* `withTenant`, exactly as a production write would be —
 * `FORCE ROW LEVEL SECURITY` applies to `allmywallet_migrator` too, since it
 * owns the table, so there is no privileged back door even for fixture
 * setup. `tableSuffix` must be unique per test file sharing a database, so
 * the fixture tables and seeded users from different suites never collide.
 */
export async function seedTwoTenants(
  appDb: ReturnType<typeof drizzle<typeof schema>>,
  migratorPool: Pool,
  tableSuffix: string,
): Promise<TwoTenantFixture> {
  const table = await createRlsHarnessTable(migratorPool, tableSuffix);

  const [tenantA] = await appDb
    .insert(users)
    .values({
      googleSubjectId: `harness-sub-a-${tableSuffix}`,
      email: `a-${tableSuffix}@example.com`,
      name: 'Tenant A',
      imageUrl: null,
    })
    .returning();
  const [tenantB] = await appDb
    .insert(users)
    .values({
      googleSubjectId: `harness-sub-b-${tableSuffix}`,
      email: `b-${tableSuffix}@example.com`,
      name: 'Tenant B',
      imageUrl: null,
    })
    .returning();
  if (!tenantA || !tenantB) throw new Error('seedTwoTenants: user seed failed');

  await withTenant(
    UserId.of(tenantA.id),
    async (tx) => {
      await tx.execute(
        sql`INSERT INTO ${sql.raw(table)} (id, user_id, label) VALUES
            (${randomUUID()}, ${tenantA.id}, 'a-row-1'),
            (${randomUUID()}, ${tenantA.id}, 'a-row-2')`,
      );
    },
    appDb,
  );
  await withTenant(
    UserId.of(tenantB.id),
    async (tx) => {
      await tx.execute(
        sql`INSERT INTO ${sql.raw(table)} (id, user_id, label) VALUES
            (${randomUUID()}, ${tenantB.id}, 'b-row-1')`,
      );
    },
    appDb,
  );

  return { table, tenantAId: tenantA.id, tenantBId: tenantB.id };
}

export async function teardownTwoTenants(
  migratorPool: Pool,
  fixture: TwoTenantFixture,
): Promise<void> {
  await dropRlsHarnessTable(migratorPool, fixture.table);
  await migratorPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    [fixture.tenantAId, fixture.tenantBId],
  ]);
}
