import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0021_corporate_event_types_and_factors.sql` (#113):
 *
 * - SPEC-006 BR-006-05's widened `transactions_type_check` /
 *   `import_rows_ledger_type_check` — the CHECKs now admit `leilao_fracoes`
 *   and `fracao_bonificacao` and still refuse everything else (AR-69: an
 *   expand-only widening).
 * - SPEC-008 BR-008-29's two new shared tables, `corporate_event_factors`
 *   and `corporate_event_factor_fetches` — declared in
 *   `src/db/shared-tables.ts`, deliberately carrying no `user_id` and no RLS
 *   (AR-15; AR-14 governs *tenant* tables, and these are not one).
 *
 * TESTING §1: CHECK-constraint enforcement and RLS-exemption behaviour
 * cannot be proven against a mock — both are asserted against real Postgres.
 */
describe('migration 0021 — corporate event types and factors (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let assetId: string;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 5 });
    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await migratorPool.query(
      'TRUNCATE corporate_event_factors, corporate_event_factor_fetches RESTART IDENTITY CASCADE',
    );
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  // TS-03: order-agnostic against a reused database — reset before every
  // test, not just once in beforeAll.
  beforeEach(async () => {
    await migratorPool.query(
      'TRUNCATE corporate_event_factors, corporate_event_factor_fetches RESTART IDENTITY CASCADE',
    );
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);

    const inserted = await migratorPool.query<{ id: string }>(
      `INSERT INTO assets (id, code, name, class) VALUES ($1, 'MGLU3', 'Magazine Luiza', 'stock') RETURNING id`,
      [randomUUID()],
    );
    assetId = inserted.rows[0]!.id;
  });

  describe('SPEC-006 BR-006-05 — the widened type CHECKs', () => {
    it('a transactions row of each new type inserts', async () => {
      for (const type of ['leilao_fracoes', 'fracao_bonificacao'] as const) {
        await withTenant(
          userId,
          async (tx) => {
            await tx.execute(sql`
              INSERT INTO transactions
                (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees, total_value, natural_key, occurrence)
              VALUES
                (${randomUUID()}, ${userId}, ${assetId}, ${type}, '2026-02-10', '1', '10.5', '0', '10.5',
                 ${`nk-${type}-${randomUUID()}`}, 1)
            `);
          },
          appDb,
        );
      }

      const { rows } = await migratorPool.query<{ type: string }>(
        `SELECT type FROM transactions WHERE user_id = $1 ORDER BY type`,
        [userId],
      );
      expect(rows.map((r) => r.type)).toEqual(['fracao_bonificacao', 'leilao_fracoes']);
    });

    it('an import_rows row of each new ledger type inserts', async () => {
      const batchId = randomUUID();
      await migratorPool.query(
        `INSERT INTO import_batches (id, user_id, source, status) VALUES ($1, $2, 'b3_movimentacao', 'pending')`,
        [batchId, userId],
      );

      for (const ledgerType of ['leilao_fracoes', 'fracao_bonificacao'] as const) {
        await withTenant(
          userId,
          async (tx) => {
            await tx.execute(sql`
              INSERT INTO import_rows
                (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id, ledger_type)
              VALUES
                (${randomUUID()}, ${userId}, ${batchId}, '{}'::jsonb, '{}'::jsonb, 'unclassified', ${assetId}, ${ledgerType})
            `);
          },
          appDb,
        );
      }

      const { rows } = await migratorPool.query<{ ledger_type: string }>(
        `SELECT ledger_type FROM import_rows WHERE user_id = $1 ORDER BY ledger_type`,
        [userId],
      );
      expect(rows.map((r) => r.ledger_type)).toEqual(['fracao_bonificacao', 'leilao_fracoes']);
    });

    it('still refuses an unknown transactions.type', async () => {
      let error: unknown;
      try {
        await withTenant(
          userId,
          async (tx) => {
            await tx.execute(sql`
              INSERT INTO transactions
                (id, user_id, asset_id, type, trade_date, quantity, unit_price, fees, total_value, natural_key, occurrence)
              VALUES
                (${randomUUID()}, ${userId}, ${assetId}, 'not_a_real_type', '2026-02-10', '1', '10.5', '0', '10.5',
                 ${`nk-${randomUUID()}`}, 1)
            `);
          },
          appDb,
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const cause = (error as Error).cause;
      expect((cause as Error | undefined)?.message ?? (error as Error).message).toMatch(
        /transactions_type_check/,
      );
    });

    it('still refuses an unknown import_rows.ledger_type', async () => {
      const batchId = randomUUID();
      await migratorPool.query(
        `INSERT INTO import_batches (id, user_id, source, status) VALUES ($1, $2, 'b3_movimentacao', 'pending')`,
        [batchId, userId],
      );

      let error: unknown;
      try {
        await withTenant(
          userId,
          async (tx) => {
            await tx.execute(sql`
              INSERT INTO import_rows
                (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id, ledger_type)
              VALUES
                (${randomUUID()}, ${userId}, ${batchId}, '{}'::jsonb, '{}'::jsonb, 'unclassified', ${assetId}, 'not_a_real_type')
            `);
          },
          appDb,
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const cause = (error as Error).cause;
      expect((cause as Error | undefined)?.message ?? (error as Error).message).toMatch(
        /import_rows_ledger_type_check/,
      );
    });
  });

  describe('SPEC-008 BR-008-29 — corporate_event_factors / corporate_event_factor_fetches (shared, no RLS)', () => {
    it('the app role reads and writes both tables with no tenant context set at all', async () => {
      // A dedicated, never-before-used connection — the same proof TS-16 uses
      // for a tenant table failing closed; here it shows the opposite is true
      // by design, because these two tables carry no tenant column to check.
      const freshPool = new Pool({ connectionString: database.appUrl, max: 1 });
      try {
        await freshPool.query(
          `INSERT INTO corporate_event_factors
             (id, issuer_code, kind, factor_published, last_date_prior, source)
           VALUES ($1, 'MGLU', 'grupamento', '0.1', '2024-05-24', 'b3_listed_companies')`,
          [randomUUID()],
        );
        const factorRows = await freshPool.query<{ issuer_code: string }>(
          `SELECT issuer_code FROM corporate_event_factors WHERE issuer_code = 'MGLU'`,
        );
        expect(factorRows.rows).toHaveLength(1);

        await freshPool.query(
          `INSERT INTO corporate_event_factor_fetches (issuer_code, fetched_at, outcome)
           VALUES ('MGLU', now(), 'ok')`,
        );
        const fetchRows = await freshPool.query<{ outcome: string }>(
          `SELECT outcome FROM corporate_event_factor_fetches WHERE issuer_code = 'MGLU'`,
        );
        expect(fetchRows.rows[0]?.outcome).toBe('ok');

        await freshPool.query(
          `UPDATE corporate_event_factor_fetches SET outcome = 'failed', failure_code = 'timeout' WHERE issuer_code = 'MGLU'`,
        );
        await freshPool.query(`DELETE FROM corporate_event_factors WHERE issuer_code = 'MGLU'`);
      } finally {
        await freshPool.end();
      }
    });

    it('the kind CHECK refuses anything but desdobramento / grupamento / bonificacao', async () => {
      await expect(
        appPool.query(
          `INSERT INTO corporate_event_factors
             (id, issuer_code, kind, factor_published, last_date_prior, source)
           VALUES ($1, 'MGLU', 'not_a_real_kind', '0.1', '2024-05-24', 'b3_listed_companies')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/corporate_event_factors_kind_check/);
    });

    it('the outcome CHECK refuses anything but ok / not_listed / failed', async () => {
      await expect(
        appPool.query(
          `INSERT INTO corporate_event_factor_fetches (issuer_code, fetched_at, outcome)
           VALUES ('MGLU', now(), 'not_a_real_outcome')`,
        ),
      ).rejects.toThrow(/corporate_event_factor_fetches_outcome_check/);
    });

    it('the unique key refuses a duplicate (issuer_code, kind, last_date_prior, factor_published)', async () => {
      await appPool.query(
        `INSERT INTO corporate_event_factors
           (id, issuer_code, kind, factor_published, last_date_prior, source)
         VALUES ($1, 'MGLU', 'grupamento', '0.1', '2024-05-24', 'b3_listed_companies')`,
        [randomUUID()],
      );

      await expect(
        appPool.query(
          `INSERT INTO corporate_event_factors
             (id, issuer_code, kind, factor_published, last_date_prior, source)
           VALUES ($1, 'MGLU', 'grupamento', '0.1', '2024-05-24', 'b3_listed_companies')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/corporate_event_factors_issuer_kind_date_factor_key/);
    });

    it('is exempt from tenant table enumeration (AR-15, src/db/shared-tables.ts)', async () => {
      const { rows } = await migratorPool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname IN ('corporate_event_factors', 'corporate_event_factor_fetches')
          ORDER BY relname`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(false);
        expect(row.relforcerowsecurity).toBe(false);
      }

      const columns = await migratorPool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'user_id'
            AND table_name IN ('corporate_event_factors', 'corporate_event_factor_fetches')`,
      );
      expect(columns.rows).toEqual([]);
    });
  });
});
