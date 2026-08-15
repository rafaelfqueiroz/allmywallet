import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSharedTable } from '@/db/shared-tables';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { RLS_HARNESS_TABLE_PREFIX } from './harness';

/**
 * SPEC-004 BR-004-09/10, DL-004-06 — "deletion cascades to every tenant-scoped
 * table. A table added later without a deletion path is a defect", verified
 * "by automated test that enumerates tables rather than checking a hardcoded
 * list." This is that test, and it is CI-blocking (issue #7's Test plan).
 *
 * It is deliberately a *sibling* of `tests/isolation/enumeration.test.ts`
 * rather than an addition to it: enumeration.test.ts proves the tenant
 * *isolation* floor (RLS present and correct); this file proves the tenant
 * *deletion* floor (a cascade path exists at all) — different questions,
 * same enumeration mechanism, so a reader can find "why does account
 * deletion work" without wading through RLS assertions to get there.
 *
 * `audit_log` is correctly absent from this check: it is declared shared/
 * exempt (`src/db/shared-tables.ts` `AUDIT_TABLES`) and its `user_id` column
 * carries **no** FK at all, on purpose — see that file's and
 * `src/db/schema/config.ts`'s comments for why an audit trail must outlive
 * the account it describes.
 */
describe('tenant table deletion coverage (SPEC-004 BR-004-10, DL-004-06)', () => {
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
    return rows
      .map((row) => row.table_name)
      .filter((name) => !isSharedTable(name))
      .filter((name) => !name.startsWith(RLS_HARNESS_TABLE_PREFIX));
  }

  it('every non-shared table has a user_id foreign key to users(id) ON DELETE CASCADE', async () => {
    const tables = await tenantScopedTables();
    const uncovered: string[] = [];

    for (const table of tables) {
      const { rows } = await pool.query<{ delete_rule: string }>(
        `SELECT rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = $1
            AND kcu.column_name = 'user_id'
            AND ccu.table_name = 'users'`,
        [table],
      );
      const cascades = rows.some((row) => row.delete_rule === 'CASCADE');
      if (!cascades) uncovered.push(table);
    }

    // AR-27: "the ON DELETE CASCADE in AR-26 is load-bearing: it is what
    // makes SPEC-004's account deletion complete and verifiable." A table
    // that fails this either has no `user_id` FK at all, or has one without
    // CASCADE — both mean deleting a `users` row leaves this table's rows
    // behind, silently violating BR-004-10.
    expect(
      uncovered,
      'tenant tables with no user_id ON DELETE CASCADE to users — DL-004-06',
    ).toEqual([]);
  });

  it('flags the meta-check itself: a table with a non-cascading user_id FK is caught', async () => {
    const table = `${RLS_HARNESS_TABLE_PREFIX}no_cascade`;
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.query(`
      CREATE TABLE ${table} (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        label text NOT NULL
      )
    `);
    try {
      const { rows } = await pool.query<{ delete_rule: string }>(
        `SELECT rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = $1
            AND kcu.column_name = 'user_id'
            AND ccu.table_name = 'users'`,
        [table],
      );
      // This scratch table is itself excluded from the real check above by
      // its `_rls_harness_` prefix — proven here directly instead, so the
      // detection logic is verified against a table it would otherwise skip.
      expect(rows.some((row) => row.delete_rule === 'CASCADE')).toBe(false);
      expect(rows[0]?.delete_rule).toBe('RESTRICT');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('audit_log is correctly excluded — declared shared, and its user_id carries no FK at all', async () => {
    expect(isSharedTable('audit_log')).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::int AS n
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = 'audit_log'
          AND kcu.column_name = 'user_id'`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
