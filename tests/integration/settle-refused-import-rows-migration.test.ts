import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * #153 / SPEC-005 BR-005-17 / SPEC-010 BR-010-12: historical refusals stop
 * needing attention when their exact occurrence exists in the active ledger.
 * All fixtures are synthetic (DV-24); no personal database is reused (AR-72).
 */
describe('migration 0033 — settle historical import refusals (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let assetId: string;
  const userA = UserId.generate();
  const userB = UserId.generate();
  const originalTime = '2026-01-01T00:00:00+00:00';
  const originalCounts = {
    read: 42,
    new: 99,
    duplicates: 99,
    needsAttention: 99,
    ignored: 99,
    fromDate: '2025-12-01',
    toDate: '2026-02-01',
    futureMetadata: { preserve: ['synthetic', 'metadata'] },
  };
  type StoredRow = Record<string, unknown> & { id: string };

  const migrationSql = () =>
    readFile(join(process.cwd(), 'src/db/migrations/0033_settle_refused_import_rows.sql'), 'utf8');

  const runMigration = async (underRls = false) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The Testcontainers migrator is a superuser. Exercise the identical SQL
      // under the actual NOBYPASSRLS app role too, proving its tenant loop works
      // without disabling or bypassing either table's forced policy (AR-11).
      if (underRls) await client.query('SET LOCAL ROLE allmywallet_app');
      await client.query(await migrationSql());
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const addBatch = async (user: string, counts: object | null = originalCounts) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO import_batches
         (id, user_id, source, status, row_counts, reconciliation,
          uploaded_at, committed_at, created_at, updated_at)
       VALUES ($1, $2, 'b3_movimentacao', 'committed', $3,
               '{"synthetic":"reconciliation"}', $4, $4, $4, $4)`,
      [id, user, counts === null ? null : JSON.stringify(counts), originalTime],
    );
    return id;
  };

  const addRow = async (
    user: string,
    batch: string,
    key: string | null,
    occurrence: number | null = 1,
    classification = 'invalid',
  ) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO import_rows
         (id, user_id, batch_id, asset_id, natural_key, occurrence, classification,
          raw_payload, parsed_payload, ledger_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{"fixture":"generated"}',
               '{"kind":"transaction","tradeDate":"2026-01-15","quantity":"1.00000000"}',
               'buy', $8, $8)`,
      [id, user, batch, assetId, key, occurrence, classification, originalTime],
    );
    return id;
  };

  const addTransaction = async (
    user: string,
    batch: string | null,
    key: string,
    occurrence = 1,
    status = 'active',
  ) => {
    await pool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, type, status, trade_date, quantity, unit_price,
          fees, total_value, natural_key, occurrence, import_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'buy', $4, '2026-01-15', '1.12345678', '12.12345678',
               '0.12345678', '13.74362691', $5, $6, $7, $8, $8)`,
      [randomUUID(), user, assetId, status, key, occurrence, batch, originalTime],
    );
  };

  const snapshot = async (table: 'import_rows' | 'import_batches' | 'transactions' | 'positions') =>
    (
      await pool.query<{ data: StoredRow }>(
        `SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`,
      )
    ).rows.map(({ data }) => data);

  beforeAll(async () => {
    database = await startTestDatabase();
    // Includes 0033: a fresh local Testcontainer rehearses the full chain on
    // an empty database before any tenants or import rows are seeded.
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.migrationUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    if (pool) {
      await resetLedger(database.migrationUrl);
      await resetUsers(database.migrationUrl);
      await pool.end();
    }
    if (database) await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userA);
    await seedUser(database.migrationUrl, userB);
    assetId = randomUUID();
    await pool.query(
      `INSERT INTO assets (id, code, name, class) VALUES ($1, 'FIXT3', 'Fixture', 'stock')`,
      [assetId],
    );
  });

  it('settles only another batch’s active exact occurrence and recounts affected batches without changing the ledger', async () => {
    const batchA = await addBatch(userA);
    const laterA = await addBatch(userA);
    const batchB = await addBatch(userB);
    const laterB = await addBatch(userB);
    const untouchedBatch = await addBatch(userA);
    const withoutCounts = await addBatch(userA, null);
    const settled = new Set<string>();
    settled.add(await addRow(userA, batchA, 'matching', 1));
    settled.add(await addRow(userA, batchA, 'matching', 1));
    settled.add(await addRow(userA, batchA, 'matching', 2));
    settled.add(await addRow(userB, batchB, 'b-matching', 1));
    settled.add(await addRow(userA, withoutCounts, 'matching', 1));
    await addTransaction(userA, laterA, 'matching', 1);
    await addTransaction(userA, laterA, 'matching', 2);
    await addTransaction(userB, laterB, 'b-matching');

    await addRow(userA, batchA, 'matching', 3);
    await addRow(userA, batchA, 'wrong-key');
    await addRow(userA, batchA, 'b-matching');
    await addRow(userB, batchB, 'matching');
    await addRow(userA, batchA, 'unclassified-ledger');
    await addTransaction(userA, laterA, 'unclassified-ledger', 1, 'unclassified');
    await addRow(userA, batchA, 'superseded-ledger');
    await addTransaction(userA, laterA, 'superseded-ledger', 1, 'superseded');
    await addRow(userA, batchA, 'same-batch');
    await addTransaction(userA, batchA, 'same-batch');
    await addRow(userA, batchA, null, null);
    await addRow(userA, batchA, 'matching', null);
    for (const classification of ['new', 'duplicate', 'unclassified', 'ignored']) {
      await addRow(userA, batchA, 'matching', 1, classification);
    }
    await addRow(userA, untouchedBatch, 'not-stored');
    await pool.query(
      `INSERT INTO positions (id, user_id, asset_id, quantity, average_cost, total_cost, realized_gain)
       VALUES ($1, $2, $3, '1.12345678', '12.12345678', '13.62017013', '0.12345678')`,
      [randomUUID(), userA, assetId],
    );
    const beforeRows = await snapshot('import_rows');
    const beforeBatches = await snapshot('import_batches');
    const beforeLedger = await snapshot('transactions');
    const beforePositions = await snapshot('positions');

    await runMigration();

    const afterRows = await snapshot('import_rows');
    for (const before of beforeRows) {
      const after = afterRows.find((row) => row.id === before.id);
      if (settled.has(before.id)) {
        expect(after).toEqual({
          ...before,
          classification: 'duplicate',
          updated_at: expect.any(String),
        });
        expect(after?.updated_at).not.toBe(before.updated_at);
      } else expect(after).toEqual(before);
    }
    const afterBatches = await snapshot('import_batches');
    for (const before of beforeBatches) {
      const after = afterBatches.find((batch) => batch.id === before.id);
      const expected =
        before.id === batchA
          ? { ...originalCounts, new: 1, duplicates: 4, needsAttention: 9, ignored: 1 }
          : { ...originalCounts, new: 0, duplicates: 1, needsAttention: 1, ignored: 0 };
      if (before.id === batchA || before.id === batchB) {
        expect(after).toEqual({ ...before, row_counts: expected, updated_at: expect.any(String) });
        expect(after?.updated_at).not.toBe(before.updated_at);
      } else expect(after).toEqual(before);
    }
    expect(await snapshot('transactions')).toEqual(beforeLedger);
    expect(await snapshot('positions')).toEqual(beforePositions);

    await runMigration();
    expect(await snapshot('import_rows')).toEqual(afterRows);
    expect(await snapshot('import_batches')).toEqual(afterBatches);
    expect(await snapshot('transactions')).toEqual(beforeLedger);
    expect(await snapshot('positions')).toEqual(beforePositions);
  });

  it('sets tenant context per tenant under forced RLS without bypass and accepts a null provenance', async () => {
    const batchA = await addBatch(userA);
    const batchB = await addBatch(userB);
    const a = await addRow(userA, batchA, 'shared');
    const b = await addRow(userB, batchB, 'shared');
    await addTransaction(userA, null, 'shared');

    await runMigration(true);

    const rows = await snapshot('import_rows');
    expect(rows.find((row) => row.id === a)?.classification).toBe('duplicate');
    expect(rows.find((row) => row.id === b)?.classification).toBe('invalid');
    const batches = await snapshot('import_batches');
    expect(batches.find((batch) => batch.id === batchA)?.row_counts).toEqual({
      ...originalCounts,
      new: 0,
      duplicates: 1,
      needsAttention: 0,
      ignored: 0,
    });
    expect(batches.find((batch) => batch.id === batchB)?.row_counts).toEqual(originalCounts);
    expect(
      (
        await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
                              WHERE relname IN ('import_rows', 'import_batches', 'transactions')`)
      ).rows,
    ).toEqual(
      Array.from({ length: 3 }, () => ({ relrowsecurity: true, relforcerowsecurity: true })),
    );
    expect(
      (await pool.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'allmywallet_app'`))
        .rows,
    ).toEqual([{ rolbypassrls: false }]);

    // TS-16: the transaction-scoped tenant context did not escape migration.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE allmywallet_app');
      await expect(client.query('SELECT * FROM import_rows')).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('runs with no users or rows and leaves all tables empty', async () => {
    await resetUsers(database.migrationUrl);
    await runMigration(true);
    expect(await snapshot('import_rows')).toEqual([]);
    expect(await snapshot('import_batches')).toEqual([]);
    expect(await snapshot('transactions')).toEqual([]);
  });
});
