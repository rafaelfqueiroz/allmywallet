import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { AssetId } from '@/core/shared/ids';
import { createWallet } from '@/core/wallets/create-wallet';
import { allocateToWallet } from '@/core/wallets/allocate';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import type { PositionRepository } from '@/core/positions/ports';
import { commitBatch } from '@/core/ingestion/commit-batch';
import type { ImportBatch } from '@/core/ingestion/ports';
import {
  buildIngestionDeps,
  handleImportCancel,
  handleImportCommit,
  buildWalletDeps,
  handleImportStage,
  saveUploadedFile,
} from '@/worker/handlers/import';
import { XlsxIngestionPort } from '@/adapters/ingestion/xlsx';
import { DrizzleFixedIncomeContractReader } from '@/adapters/db/fixed-income-contract-repository';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import {
  buildMovimentacaoXlsx,
  buildPosicaoXlsx,
  SYNTHETIC_CPF,
} from '@/adapters/ingestion/xlsx/test-support/builder';
import { isValidCpf } from '@/adapters/ingestion/xlsx/strip-cpf';

/**
 * SPEC-005 (#8) — the full stage → commit → reconcile pipeline against real
 * Postgres, exercising the worker handlers exactly as production does: real
 * files on disk, real `withTenant` transactions, real jsonb round-trips.
 *
 * TESTING §1: this is the one place `NUMERIC` ⇄ `Decimal` round-tripping,
 * the atomic-commit rollback, and RLS-scoped writes can be proven at all —
 * mocking any of them would mock away the thing under test.
 */
describe('SPEC-005 — import pipeline (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let uploadDir: string;

  const userId = UserId.generate();
  const clock = new FakeClock('2026-03-20T12:00:00-03:00');

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    // TS-03: CI runs every suite against one shared Postgres.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);
    uploadDir = await mkdtemp(join(tmpdir(), 'amw-import-'));
    snapshotJobs = [];
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function newPendingBatch(source: ImportBatch['source']): Promise<ImportBatchId> {
    const batchId = ImportBatchId.generate();
    await withTenant(
      userId,
      async (tx) =>
        new DrizzleImportBatchRepository(tx, userId).insert({
          id: batchId,
          userId,
          source,
          status: 'pending',
          uploadedAt: clock.now(),
          committedAt: null,
          rowCounts: null,
          reconciliation: null,
        }),
      appDb,
    );
    return batchId;
  }

  async function batchRow(batchId: ImportBatchId) {
    const { rows } = await migratorPool.query(
      'SELECT status, row_counts, reconciliation FROM import_batches WHERE id = $1',
      [batchId],
    );
    return rows[0] as { status: string; row_counts: unknown; reconciliation: unknown } | undefined;
  }

  /**
   * SPEC-009 BR-009-18: captured rather than enqueued for real, so a test can
   * assert *that* a rebuild was requested and *from when* without pg-boss.
   */
  let snapshotJobs: { userId?: string; from?: string }[] = [];

  const handlerDeps = () => ({
    database: appDb,
    clock,
    ingestion: new XlsxIngestionPort(),
    uploadDir,
    enqueueSnapshot: async (payload: { userId?: string; from?: string }) => {
      snapshotJobs.push(payload);
    },
  });

  /**
   * SPEC-010 BR-010-10/17 — the wiring test.
   *
   * `applyBuy` and `applySell` had no caller until
   * `core/wallets/apply-ledger-effects.ts`, so this is the assertion that was
   * missing: not "does the use case work" — its own unit tests always passed —
   * but "does committing an import reach it at all". Reverting the two lines
   * in `handleImportCommit` fails both halves of this.
   */
  it('BR-010-10/17: committing an import moves allocations, and never leaves allocated > held', async () => {
    // A wallet holding the whole position.
    const buyBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      buyBatch,
      await buildMovimentacaoXlsx([
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '10,00',
        },
      ]),
    );
    await handleImportStage({ batchId: buyBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: buyBatch, userId }, handlerDeps());

    const { rows: assetRows } = await migratorPool.query(
      "SELECT id FROM assets WHERE code = 'PETR4'",
    );
    const assetId = assetRows[0]?.id as string;

    const wallet = await withTenant(
      userId,
      async (tx) => {
        const deps = buildWalletDeps(tx, userId, clock);
        const created = await createWallet(deps, userId, { name: 'Aposentadoria' });
        if (!created.ok) throw new Error('wallet setup failed');
        await allocateToWallet(deps, userId, {
          walletId: created.value.id,
          assetId: AssetId.of(assetId),
        });
        return created.value;
      },
      appDb,
    );

    const allocatedFor = async (): Promise<string | undefined> => {
      const { rows } = await migratorPool.query(
        'SELECT quantity::text AS q FROM wallet_allocations WHERE wallet_id = $1',
        [wallet.id],
      );
      return rows[0]?.q as string | undefined;
    };

    expect(await allocatedFor()).toBe('100.00000000');

    // Now sell 40 through a second import. Without the wiring the position
    // drops to 60 and the allocation stays at 100 — BR-010-05 violated.
    const sellBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      sellBatch,
      await buildMovimentacaoXlsx([
        {
          data: '20/02/2026',
          movimentacao: 'Venda',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '40',
          precoUnitario: '12,00',
        },
      ]),
    );
    await handleImportStage({ batchId: sellBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: sellBatch, userId }, handlerDeps());

    const { rows: held } = await migratorPool.query(
      'SELECT quantity::text AS q FROM positions WHERE user_id = $1 AND asset_id = $2',
      [userId, assetId],
    );
    expect(held[0]?.q).toBe('60.00000000');

    // The whole point: the allocation came down with the position.
    expect(await allocatedFor()).toBe('60.00000000');
  });

  /**
   * SPEC-009 BR-009-18 / AC-15 — the rebuild caller.
   *
   * `SnapshotJobPayload.from` existed and was tested from the handler's side;
   * nothing in the application ever sent it. The symptom was a chart that kept
   * last night's shape after a backdated import, until a nightly sweep
   * rebuilt the tenant's entire history for want of a start date.
   */
  it('BR-009-18: committing a batch asks for a rebuild from its earliest trade date', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          data: '20/02/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '10',
          precoUnitario: '30,00',
        },
        {
          // Backdated relative to the row above — this is the date the rebuild
          // has to start from, not the batch's newest or its upload date.
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '5',
          precoUnitario: '28,00',
        },
      ]),
    );

    await handleImportStage({ batchId, userId }, handlerDeps());
    expect(snapshotJobs).toHaveLength(0); // staging invalidates nothing

    await handleImportCommit({ batchId, userId }, handlerDeps());

    expect(snapshotJobs).toHaveLength(1);
    expect(snapshotJobs[0]?.userId).toBe(userId);
    expect(snapshotJobs[0]?.from).toBe('2026-01-10');
  });

  it('BR-009-18: a commit that applied nothing asks for no rebuild', async () => {
    // A batch of pure duplicates invalidates no snapshot. Enqueueing a
    // full-history rebuild for it would be the opposite of targeted.
    const rows = [
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ];

    const first = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, first, await buildMovimentacaoXlsx(rows));
    await handleImportStage({ batchId: first, userId }, handlerDeps());
    await handleImportCommit({ batchId: first, userId }, handlerDeps());
    snapshotJobs = [];

    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, await buildMovimentacaoXlsx(rows));
    await handleImportStage({ batchId: second, userId }, handlerDeps());
    await handleImportCommit({ batchId: second, userId }, handlerDeps());

    expect(snapshotJobs).toHaveLength(0);
  });

  it('BR-005-09..13: stage then commit — the ledger only changes after commit', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    const bytes = await buildMovimentacaoXlsx([
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ]);
    await saveUploadedFile(uploadDir, batchId, bytes);

    await handleImportStage({ batchId, userId }, handlerDeps());
    let row = await batchRow(batchId);
    expect(row?.status).toBe('previewed');

    const { rows: txBeforeCommit } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txBeforeCommit[0]?.n)).toBe(0);

    await handleImportCommit({ batchId, userId }, handlerDeps());
    row = await batchRow(batchId);
    expect(row?.status).toBe('committed');

    const { rows: txAfterCommit } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE type = $1',
      ['buy'],
    );
    expect(Number(txAfterCommit[0]?.n)).toBe(1);

    // BR-005-12/DL-005-07: deleted after commit.
    await expect(readFile(join(uploadDir, `${batchId}.xlsx`))).rejects.toThrow();
  });

  it('BR-005-17/AC: importing full history then re-importing an overlapping range yields identical positions and zero duplicates', async () => {
    const fullHistory = [
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '30',
      },
      {
        data: '15/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '50',
        precoUnitario: '32',
      },
      {
        data: '20/01/2026',
        movimentacao: 'Venda',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '30',
        precoUnitario: '35',
      },
    ];

    const firstBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, firstBatch, await buildMovimentacaoXlsx(fullHistory));
    await handleImportStage({ batchId: firstBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: firstBatch, userId }, handlerDeps());

    const { rows: positionAfterFirst } = await migratorPool.query('SELECT quantity FROM positions');
    expect(positionAfterFirst).toHaveLength(1);
    expect(positionAfterFirst[0]?.quantity).toBe('120.00000000');

    // Re-import an overlapping export: the last two rows again, plus one
    // genuinely new trade the user made since.
    const overlapping = [
      fullHistory[1] as (typeof fullHistory)[number],
      fullHistory[2] as (typeof fullHistory)[number],
      {
        data: '25/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '10',
        precoUnitario: '36',
      },
    ];
    const secondBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, secondBatch, await buildMovimentacaoXlsx(overlapping));
    await handleImportStage({ batchId: secondBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: secondBatch, userId }, handlerDeps());

    const { rows: txCount } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    // 3 from the first import + exactly 1 genuinely new row from the second.
    expect(Number(txCount[0]?.n)).toBe(4);

    const { rows: positionAfterSecond } = await migratorPool.query(
      'SELECT quantity FROM positions',
    );
    expect(positionAfterSecond).toHaveLength(1);
    // 120 (first import) + 10 (the one genuinely new row) = 130.
    expect(positionAfterSecond[0]?.quantity).toBe('130.00000000');
  });

  it('BR-005-16/AC: two genuine identical same-day trades both import; re-importing the same file adds neither again', async () => {
    const row = {
      data: '10/01/2026',
      movimentacao: 'Compra',
      produto: 'VALE3 - Vale ON',
      quantidade: '10',
      precoUnitario: '61.2',
    };

    const firstBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, firstBatch, await buildMovimentacaoXlsx([row, row]));
    await handleImportStage({ batchId: firstBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: firstBatch, userId }, handlerDeps());

    const { rows: afterFirst } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(afterFirst[0]?.n)).toBe(2);

    const secondBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, secondBatch, await buildMovimentacaoXlsx([row, row]));
    await handleImportStage({ batchId: secondBatch, userId }, handlerDeps());
    const commitResult = await handleImportCommit({ batchId: secondBatch, userId }, handlerDeps());
    void commitResult;

    const { rows: afterSecond } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(afterSecond[0]?.n)).toBe(2);
  });

  it('BR-005-12/AC: cancel leaves the ledger untouched, removes staged rows and deletes the source file', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    const bytes = await buildMovimentacaoXlsx([
      {
        data: '10/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '32,15',
      },
    ]);
    await saveUploadedFile(uploadDir, batchId, bytes);
    await handleImportStage({ batchId, userId }, handlerDeps());

    const { rows: rowsBefore } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM import_rows',
    );
    expect(Number(rowsBefore[0]?.n)).toBe(1);

    await handleImportCancel({ batchId, userId }, handlerDeps());

    const row = await batchRow(batchId);
    expect(row?.status).toBe('discarded');
    const { rows: rowsAfter } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM import_rows',
    );
    expect(Number(rowsAfter[0]?.n)).toBe(0);
    const { rows: txAfter } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txAfter[0]?.n)).toBe(0);
    await expect(readFile(join(uploadDir, `${batchId}.xlsx`))).rejects.toThrow();
  });

  it('BR-005-13/AC: a commit interrupted mid-way leaves no partial batch', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '32,15',
        },
        {
          data: '11/01/2026',
          movimentacao: 'Compra',
          produto: 'VALE3 - Vale ON',
          quantidade: '10',
          precoUnitario: '61.2',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());

    // A synthetic failure after the ledger inserts have already run inside
    // the same `withTenant` transaction — proving the whole transaction
    // rolls back, not just the step that threw.
    await expect(
      withTenant(
        userId,
        async (tx) => {
          const deps = buildIngestionDeps(tx, userId, clock);
          const throwingPositions: PositionRepository = {
            ...deps.positions,
            upsertMany: async () => {
              throw new Error('simulated interruption after ledger inserts');
            },
          };
          return commitBatch({ ...deps, positions: throwingPositions }, userId, { batchId });
        },
        appDb,
      ),
    ).rejects.toThrow('simulated interruption');

    const { rows: txAfter } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txAfter[0]?.n)).toBe(0);
    const { rows: posAfter } = await migratorPool.query('SELECT count(*)::int AS n FROM positions');
    expect(Number(posAfter[0]?.n)).toBe(0);
    const row = await batchRow(batchId);
    expect(row?.status).toBe('previewed'); // never reached 'committed'
  });

  it('BR-005-06/BR-005-22..24/AC: reconciliation is clean against a matching snapshot and attributes an induced discrepancy', async () => {
    const historyBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      historyBatch,
      await buildMovimentacaoXlsx([
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '32,15',
        },
      ]),
    );
    await handleImportStage({ batchId: historyBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: historyBatch, userId }, handlerDeps());

    // A same-date Posição snapshot agreeing exactly — clean reconciliation.
    const cleanBatch = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      cleanBatch,
      await buildPosicaoXlsx([
        { produto: 'PETR4', categoria: 'Ações', quantidade: '100', dataReferencia: '20/01/2026' },
      ]),
    );
    await handleImportStage({ batchId: cleanBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: cleanBatch, userId }, handlerDeps());
    const clean = await batchRow(cleanBatch);
    expect((clean?.reconciliation as { status: string } | null)?.status).toBe('reconciled');

    // An induced discrepancy: B3 shows 90, the ledger computes 100 — a
    // surplus with no unclassified row to blame reads as an uncaptured
    // corporate event (BR-005-24).
    const discrepantBatch = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      discrepantBatch,
      await buildPosicaoXlsx([
        { produto: 'PETR4', categoria: 'Ações', quantidade: '90', dataReferencia: '20/01/2026' },
      ]),
    );
    await handleImportStage({ batchId: discrepantBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: discrepantBatch, userId }, handlerDeps());
    const discrepant = await batchRow(discrepantBatch);
    const reconciliation = discrepant?.reconciliation as {
      status: string;
      discrepancies: { cause: string; difference: string }[];
    } | null;
    expect(reconciliation?.status).toBe('discrepancies_found');
    expect(reconciliation?.discrepancies).toHaveLength(1);
    expect(reconciliation?.discrepancies[0]?.cause).toBe('uncaptured_corporate_event');
    expect(reconciliation?.discrepancies[0]?.difference).toBe('-10');
  });

  it('BR-005-06/AC: a CDB Posição row creates a fixed_income_contracts row the valuation reader can find', async () => {
    const batchId = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildPosicaoXlsx([
        {
          produto: 'CDB Banco Teste',
          categoria: 'CDB',
          quantidade: '1',
          dataReferencia: '20/01/2026',
          indexador: 'CDI',
          taxaContratada: '110',
          dataEmissao: '01/01/2024',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());
    await handleImportCommit({ batchId, userId }, handlerDeps());

    const { rows: assetRows } = await migratorPool.query(
      "SELECT id FROM assets WHERE code = 'CDB Banco Teste'",
    );
    const assetId = assetRows[0]?.id as string;
    expect(assetId).toBeTruthy();

    // `DrizzleFixedIncomeContractReader` opens its own short `withTenant` per
    // lookup (see that class's doc comment) — exactly the shape
    // `rebuildTenant` (SPEC-009) calls it in, so this proves the real wiring
    // without needing an outer transaction of its own.
    const contract = await new DrizzleFixedIncomeContractReader(appDb, userId).findByAssetId(
      assetId as never,
    );
    expect(contract?.indexer).toBe('cdi_percent');
    expect(contract?.ratePercent?.toString()).toBe('110');
  });

  it('BR-005-07/AC: no CPF exists anywhere after import — a raw SQL scan of import_rows.raw_payload', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    // Default metadata block embeds SYNTHETIC_CPF, a checksum-valid CPF.
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '32,15',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());

    const { rows } = await migratorPool.query<{ raw_payload: unknown; parsed_payload: unknown }>(
      'SELECT raw_payload, parsed_payload FROM import_rows',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(containsCpf(row.raw_payload)).toBe(false);
      expect(containsCpf(row.parsed_payload)).toBe(false);
    }
    // Sanity: the CPF really was checksum-valid, so the assertion above is meaningful.
    expect(isValidCpf(SYNTHETIC_CPF.replace(/\D/g, ''))).toBe(true);
  });

  /**
   * The test above puts the CPF only in the leading metadata block, which
   * BR-005-04 skips before it ever reaches a data row — so it passes whether
   * or not `stripCpf` does anything, and proves the *absence of a path* rather
   * than the stripping. Verified by neutering `stripCpf` to the identity
   * function: that test still passed.
   *
   * This one puts a checksum-valid CPF in a **data cell**, which is the case
   * that exercises the wiring end to end. B3 does not put a CPF in `Produto`,
   * but nothing prevents one appearing in a free-text cell, and the point here
   * is to pin the call site: if a future change drops `sanitizeRow` from a
   * parser, the unit tests on `stripCpf` still pass and only this fails.
   */
  it('BR-005-07/AC: a CPF in a DATA cell is stripped from both payloads, not merely absent', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          data: '10/01/2026',
          movimentacao: 'Compra',
          produto: `PETR4 - Petrobras PN ${SYNTHETIC_CPF}`,
          quantidade: '100',
          precoUnitario: '32,15',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());

    const { rows } = await migratorPool.query<{ raw_payload: unknown; parsed_payload: unknown }>(
      'SELECT raw_payload, parsed_payload FROM import_rows',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(containsCpf(row.raw_payload)).toBe(false);
      expect(containsCpf(row.parsed_payload)).toBe(false);
    }
  });
});

function containsCpf(value: unknown): boolean {
  if (typeof value === 'string') {
    const bare = value.match(/\d{11}/g) ?? [];
    if (bare.some((candidate) => isValidCpf(candidate))) return true;
    return /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsCpf);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsCpf);
  }
  return false;
}
