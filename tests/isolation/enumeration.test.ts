import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSharedTable } from '@/db/shared-tables';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { RLS_HARNESS_TABLE_PREFIX, createRlsHarnessTable, dropRlsHarnessTable } from './harness';

/**
 * TS-13 — the blocking gate, and the real deliverable of SPEC-003.
 *
 * Cross-tenant leakage is PRD risk R6: low likelihood, severe impact, and
 * **invisible in single-user development** — a query missing its tenant filter
 * returns your own rows and looks perfectly correct.
 *
 * This test enumerates tables **from the database** (`pg_class`) rather than
 * from a maintained list. A list goes stale silently the first time someone
 * adds a table and forgets to update it; enumeration fails loudly at CI time,
 * which is the whole difference.
 *
 * It passes trivially while no tenant table exists — #4/#6 introduce none;
 * `users`/`sessions`/`accounts`/`verification_tokens` are all declared-exempt
 * auth substrate (`src/db/shared-tables.ts`'s `AUTH_SUBSTRATE_TABLES`) — and
 * grows teeth automatically as each later spec adds one. That is intended:
 * the gate is in place before the first tenant table, not retrofitted onto a
 * populated one.
 */
describe('tenant table enumeration', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  async function tenantScopedTables(): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname = 'public'
       ORDER BY c.relname
    `);
    return (
      rows
        .map((row) => row.table_name)
        .filter((name) => !isSharedTable(name))
        // The harness's own scratch tables are filtered here rather than in
        // `isSharedTable`, so the production declaration cannot be used to smuggle
        // a real table past the gate by naming it `_rls_harness_something`.
        // Sequential execution (`fileParallelism: false`) means one file's
        // teardown has run before another file's enumeration query, so this only
        // matters after a crashed test — but a confusing failure in an unrelated
        // file is exactly what makes a gate get disabled.
        .filter((name) => !name.startsWith(RLS_HARNESS_TABLE_PREFIX))
    );
  }

  it('every non-shared table carries user_id', async () => {
    const tables = await tenantScopedTables();
    const missing: string[] = [];

    for (const table of tables) {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'user_id'`,
        [table],
      );
      if (rows.length === 0) missing.push(table);
    }

    // AR-26: `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`.
    // Without the column there is nothing for a policy to compare against.
    expect(missing, 'tables without user_id — declare them shared or scope them').toEqual([]);
  });

  it('every non-shared table has ENABLE *and* FORCE row level security', async () => {
    const tables = await tenantScopedTables();
    const unprotected: string[] = [];

    for (const table of tables) {
      const { rows } = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      const flags = rows[0];
      // FORCE matters as much as ENABLE: a table owner bypasses its own policies
      // without it, and migrations run as the owner (ARCHITECTURE §5).
      if (!flags?.relrowsecurity || !flags.relforcerowsecurity) unprotected.push(table);
    }

    expect(unprotected, 'tables missing ENABLE or FORCE row level security').toEqual([]);
  });

  it('every non-shared table has a policy covering reads and writes', async () => {
    const tables = await tenantScopedTables();
    const uncovered: string[] = [];

    for (const table of tables) {
      const { rows } = await pool.query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      // WITH CHECK matters as much as USING — without it a tenant can *insert*
      // rows attributed to another (SPEC-003).
      const covered = rows.some((row) => row.qual !== null && row.with_check !== null);
      if (!covered) uncovered.push(table);
    }

    expect(uncovered, 'tables without a USING + WITH CHECK policy').toEqual([]);
  });

  it('every non-shared table is named by an isolation test', async () => {
    const tables = await tenantScopedTables();
    const directory = join(process.cwd(), 'tests/isolation');
    const corpus = readdirSync(directory)
      .filter((file) => file.endsWith('.test.ts') && file !== 'enumeration.test.ts')
      .map((file) => readFileSync(join(directory, file), 'utf8'))
      .join('\n');

    // TS-14: coverage means a test at the API and report surface, not a
    // repository test. This check cannot verify that — it verifies the weaker
    // property that nobody added a table with no test at all.
    const untested = tables.filter((table) => !corpus.includes(table));
    expect(untested, 'tenant tables with no isolation test — CI blocks on this').toEqual([]);
  });

  it('declares the shared tables explicitly rather than inferring them', () => {
    // BR-003-06. If this list ever shrinks to nothing by accident, every table
    // becomes tenant-scoped and the suite fails loudly rather than quietly
    // exempting things.
    expect(isSharedTable('assets')).toBe(true);
    expect(isSharedTable('price_quotes')).toBe(true);
    expect(isSharedTable('transactions')).toBe(false);
  });

  it('users — the tenant root (#4) — is deliberately not RLS-scoped at all', async () => {
    // Locking this in here, against the live schema, means an accidental
    // `ENABLE ROW LEVEL SECURITY` on `users` (which would make every join to
    // it start failing outside withTenant, since nothing ever calls
    // withTenant('users lookup')) is caught immediately rather than
    // discovered downstream in a report query.
    const { rows } = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'users' AND relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]?.relrowsecurity).toBe(false);
  });

  describe('the enumeration mechanism itself (proven against a scratch table)', () => {
    it('recognises a correctly-built tenant table as compliant', async () => {
      const table = await createRlsHarnessTable(pool, 'compliant');
      try {
        const { rows } = await pool.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );
        expect(rows[0]?.relrowsecurity).toBe(true);
        expect(rows[0]?.relforcerowsecurity).toBe(true);

        const policy = await pool.query<{ qual: string | null; with_check: string | null }>(
          `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
          [table],
        );
        expect(policy.rows.some((r) => r.qual !== null && r.with_check !== null)).toBe(true);
      } finally {
        await dropRlsHarnessTable(pool, table);
      }
    });

    it('flags a table that has user_id but no RLS at all', async () => {
      const table = '_rls_harness_no_rls';
      await pool.query(`
        CREATE TABLE ${table} (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label text NOT NULL
        )
      `);
      try {
        const { rows } = await pool.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );
        expect(rows[0]?.relrowsecurity).toBe(false);
        expect(rows[0]?.relforcerowsecurity).toBe(false);
      } finally {
        await dropRlsHarnessTable(pool, table);
      }
    });

    it('flags a table with RLS enabled but not FORCED — the owner-bypass gap AR-14 exists to close', async () => {
      const table = '_rls_harness_not_forced';
      await pool.query(`
        CREATE TABLE ${table} (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label text NOT NULL
        )
      `);
      await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await pool.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING      (user_id = current_setting('app.user_id')::uuid)
          WITH CHECK (user_id = current_setting('app.user_id')::uuid)
      `);
      try {
        const { rows } = await pool.query<{
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );
        expect(rows[0]?.relrowsecurity).toBe(true);
        expect(rows[0]?.relforcerowsecurity).toBe(false);
      } finally {
        await dropRlsHarnessTable(pool, table);
      }
    });

    it('flags a policy with USING but no WITH CHECK — the insert-as-another-tenant gap', async () => {
      const table = '_rls_harness_using_only';
      await pool.query(`
        CREATE TABLE ${table} (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label text NOT NULL
        )
      `);
      await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await pool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      // USING only, deliberately — the exact mistake AR-14's checklist calls out.
      await pool.query(`
        CREATE POLICY tenant_isolation ON ${table}
          USING (user_id = current_setting('app.user_id')::uuid)
      `);
      try {
        const { rows } = await pool.query<{ qual: string | null; with_check: string | null }>(
          `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
          [table],
        );
        expect(rows.some((r) => r.qual !== null && r.with_check !== null)).toBe(false);
      } finally {
        await dropRlsHarnessTable(pool, table);
      }
    });
  });
});
