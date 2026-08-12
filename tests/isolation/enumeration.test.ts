import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SHARED_TABLES, isSharedTable } from '@/db/shared-tables';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * TS-13 — the blocking gate, and the real deliverable of SPEC-003.
 *
 * Cross-tenant leakage is PRD risk R6: low likelihood, severe impact, and
 * **invisible in single-user development** — a query missing its tenant filter
 * returns your own rows and looks perfectly correct.
 *
 * This test enumerates tables **from the database** rather than from a
 * maintained list. A list goes stale silently the first time someone adds a
 * table and forgets to update it; enumeration fails loudly at CI time, which is
 * the whole difference.
 *
 * It passes trivially while no tenant table exists, and grows teeth
 * automatically as each spec adds one. That is intended: the gate is in place
 * before the first table, not retrofitted onto a populated one.
 */
describe('tenant table enumeration', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
  });

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
    return rows.map((row) => row.table_name).filter((name) => !isSharedTable(name));
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
    expect(missing, `tables without user_id — declare them shared or scope them`).toEqual([]);
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
    // property that nobody added a table and no test at all.
    const untested = tables.filter((table) => !corpus.includes(table));
    expect(untested, 'tenant tables with no isolation test — CI blocks on this').toEqual([]);
  });

  it('declares the shared tables explicitly rather than inferring them', () => {
    // BR-003-06. If this list ever shrinks to nothing by accident, every table
    // becomes tenant-scoped and the suite fails loudly rather than quietly
    // exempting things.
    expect(SHARED_TABLES).toContain('assets');
    expect(SHARED_TABLES).toContain('price_quotes');
    expect(isSharedTable('assets')).toBe(true);
    expect(isSharedTable('transactions')).toBe(false);
  });
});
