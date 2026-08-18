import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { FakeClock } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';
import { buildNegociacaoXlsx } from '@/adapters/ingestion/xlsx/test-support/builder';
import { handleImportCommit, handleImportStage } from '@/worker/handlers/import';
import { withTenant } from '@/db/tenant';
import { REFERENCE_TRANSACTION_COUNT, generateReferenceWorkload } from '@/db/reference-workload';

/**
 * SPEC-005's performance criterion: "**An import of 10,000 rows previews in
 * under 30s and commits in under 60s.**"
 *
 * Nightly and advisory (DL-016-03), like every other budget. This is the one
 * SPEC-016's own suite said could not be measured yet — the reference workload
 * had no rows to build a file from until #73 persisted it.
 *
 * **The queue is deliberately not in the measurement.** `import.stage` and
 * `import.commit` sit behind pg-boss, whose poll interval adds seconds that
 * belong to the scheduler rather than to the import. The budgets are about
 * the work — parse, stage, reconcile, write — so the handlers are invoked
 * directly, exactly as `tests/integration/import-pipeline.test.ts` does.
 *
 * The rows come from the same generator the nightly budgets are stated
 * against (BR-016-01), so "10.000 rows" here means the same 10.000 rows as
 * everywhere else rather than a number someone picked.
 */

const PREVIEW_BUDGET_MS = 30_000;
const COMMIT_BUDGET_MS = 60_000;

describe('SPEC-005 — a 10.000-row import at the stated budgets (nightly, advisory)', () => {
  const userId = UserId.generate();
  const clock = new FakeClock('2026-06-30T12:00:00Z');

  let pool: Pool;
  let migratorPool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let uploadDir: string;
  let extract: Uint8Array;

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? appUrl;
    if (appUrl === undefined || migrationUrl === undefined) {
      throw new Error(
        'DATABASE_URL / DATABASE_MIGRATION_URL are required — this suite measures a real database',
      );
    }

    pool = new Pool({ connectionString: appUrl, max: 4 });
    migratorPool = new Pool({ connectionString: migrationUrl, max: 1 });
    db = drizzle(pool, { schema });
    uploadDir = await mkdtemp(join(tmpdir(), 'amw-import-budget-'));

    await migratorPool.query(
      `INSERT INTO users (id, google_subject_id, email, name)
       VALUES ($1, $2, $3, 'import budget')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `import-budget-${userId}`, `import-budget-${userId}@example.invalid`],
    );

    /**
     * A Negociação extract of exactly the reference workload's size. Trades
     * only — Negociação carries no proventos — and every row a buy, because a
     * sale of something this file has not yet established is a reconciliation
     * question rather than a throughput one, and the budget is about
     * throughput.
     */
    const { transactions } = generateReferenceWorkload();
    extract = await buildNegociacaoXlsx(
      transactions.map((transaction) => ({
        data: toBrDate(transaction.date),
        tipo: 'Compra',
        codigo: transaction.ticker,
        quantidade: String(transaction.quantity),
        preco: centsToBr(transaction.unitPriceCents),
      })),
    );
    expect(transactions).toHaveLength(REFERENCE_TRANSACTION_COUNT);
  }, 600_000);

  afterAll(async () => {
    await migratorPool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
    await migratorPool.end();
    await rm(uploadDir, { recursive: true, force: true });
  });

  function handlerDeps() {
    return {
      database: db,
      clock,
      ingestion: new XlsxIngestionPort(),
      uploadDir,
      enqueueSnapshot: async () => {},
    };
  }

  it('previews 10.000 rows within budget, and commits within budget', async () => {
    const batchId = ImportBatchId.generate();

    await withTenant(
      userId,
      async (tx) => {
        await tx.insert(schema.importBatches).values({
          id: batchId,
          userId,
          source: 'b3_negociacao',
          status: 'pending',
          uploadedAt: clock.now(),
        });
      },
      db,
    );
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, `${batchId}.xlsx`), extract);

    const stagedAt = performance.now();
    await handleImportStage({ batchId, userId }, handlerDeps());
    const previewMs = performance.now() - stagedAt;

    const committedAt = performance.now();
    await handleImportCommit({ batchId, userId }, handlerDeps());
    const commitMs = performance.now() - committedAt;

    console.info(
      `[budget] import 10.000 rows: preview ${(previewMs / 1000).toFixed(1)}s, ` +
        `commit ${(commitMs / 1000).toFixed(1)}s`,
    );

    // Asserted after both are logged, so a nightly run that misses one budget
    // still reports the other rather than stopping at the first failure.
    expect(previewMs).toBeLessThan(PREVIEW_BUDGET_MS);
    expect(commitMs).toBeLessThan(COMMIT_BUDGET_MS);

    // A budget met by importing nothing is not a budget met.
    const { rows } = await migratorPool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM transactions WHERE user_id = $1',
      [userId],
    );
    expect(Number(rows[0]?.total ?? '0')).toBe(REFERENCE_TRANSACTION_COUNT);
  }, 600_000);
});

/** The generator holds ISO dates; B3 extracts are `DD/MM/YYYY`. */
function toBrDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

/** Cents to the pt-BR literal a Negociação cell carries — never a float (AR-06). */
function centsToBr(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}
