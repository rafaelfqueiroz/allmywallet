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
import { TEST_CORPORATE_EVENT_WINDOWS } from '@/core/ingestion/test-support/build-deps';
import { createWallet } from '@/core/wallets/create-wallet';
import { allocateToWallet } from '@/core/wallets/allocate';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import type { PositionRepository } from '@/core/positions/ports';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { classifyImportRow } from '@/core/ingestion/classify-row';
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
import { InstitutionId, TransactionId } from '@/core/shared/ids';
import { acceptReconciliationAdjustment } from '@/core/ingestion/accept-adjustment';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import { UNCLASSIFIED_PLACEHOLDER_TYPE, importNaturalKeyFor } from '@/core/ingestion/occurrence';
import { DrizzleImportRowRepository } from '@/adapters/db/import-row-repository';
import { DrizzleFixedIncomeContractReader } from '@/adapters/db/fixed-income-contract-repository';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { verifyPositions } from '@/core/positions/rebuild';
import {
  buildMovimentacaoXlsx,
  buildNegociacaoXlsx,
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
          failureCode: null,
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
   * SPEC-010 BR-010-05 — a batch carrying a round trip in an allocated asset.
   *
   * This is the case that could not commit *at all*. `applyBuy` checked the
   * sum invariant against the position cache, which by then already reflected
   * the whole batch, so replaying the buy saw 100 held and 150 claimed and
   * refused. `handleImportCommit` returned the error, the tenant transaction
   * rolled back, and pg-boss retried a deterministic failure indefinitely —
   * one monthly extract containing a buy and a later sell of an asset the user
   * had filed into a wallet was enough to wedge their imports permanently.
   *
   * A single batch, not two: the ordering inside one commit is the whole
   * point, and splitting it across commits is what made the unit tests pass.
   */
  it('BR-010-05: a batch with a buy and a later sell of an allocated asset commits', async () => {
    const seedBatch = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      seedBatch,
      await buildMovimentacaoXlsx([
        {
          data: '05/01/2026',
          movimentacao: 'Compra',
          produto: 'VALE3 - Vale ON',
          quantidade: '100',
          precoUnitario: '60,00',
        },
      ]),
    );
    await handleImportStage({ batchId: seedBatch, userId }, handlerDeps());
    await handleImportCommit({ batchId: seedBatch, userId }, handlerDeps());

    const { rows: assetRows } = await migratorPool.query(
      "SELECT id FROM assets WHERE code = 'VALE3'",
    );
    const assetId = assetRows[0]?.id as string;

    const wallet = await withTenant(
      userId,
      async (tx) => {
        const deps = buildWalletDeps(tx, userId, clock);
        const created = await createWallet(deps, userId, { name: 'Longo prazo' });
        if (!created.ok) throw new Error('wallet setup failed');
        await allocateToWallet(deps, userId, {
          walletId: created.value.id,
          assetId: AssetId.of(assetId),
        });
        return created.value;
      },
      appDb,
    );

    // One batch, both legs. Net effect on the position is zero.
    const roundTrip = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      roundTrip,
      await buildMovimentacaoXlsx([
        {
          data: '02/03/2026',
          movimentacao: 'Compra',
          produto: 'VALE3 - Vale ON',
          quantidade: '50',
          precoUnitario: '62,00',
        },
        {
          data: '20/03/2026',
          movimentacao: 'Venda',
          produto: 'VALE3 - Vale ON',
          quantidade: '50',
          precoUnitario: '65,00',
        },
      ]),
    );
    await handleImportStage({ batchId: roundTrip, userId }, handlerDeps());
    await handleImportCommit({ batchId: roundTrip, userId }, handlerDeps());

    // The batch committed rather than rolling back forever.
    const { rows: batchRows } = await migratorPool.query(
      'SELECT status FROM import_batches WHERE id = $1',
      [roundTrip],
    );
    expect(batchRows[0]?.status).toBe('committed');

    const { rows: held } = await migratorPool.query(
      'SELECT quantity::text AS q FROM positions WHERE user_id = $1 AND asset_id = $2',
      [userId, assetId],
    );
    expect(held[0]?.q).toBe('100.00000000');

    const { rows: allocated } = await migratorPool.query(
      'SELECT quantity::text AS q FROM wallet_allocations WHERE wallet_id = $1',
      [wallet.id],
    );
    expect(allocated[0]?.q).toBe('100.00000000');
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

  it('BR-005-20c/AC: commits an exact grouped conversion and re-imports it without another companion', async () => {
    const importFile = async (rows: Parameters<typeof buildMovimentacaoXlsx>[0]) => {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(uploadDir, batchId, await buildMovimentacaoXlsx(rows));
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit({ batchId, userId }, handlerDeps());
      return batchId;
    };
    await importFile([
      {
        entradaSaida: 'Credito',
        data: '02/01/2025',
        movimentacao: 'Compra',
        produto: 'ELET3 - Eletrobras ON',
        instituicao: 'CORRETORA TESTE',
        quantidade: '260',
        precoUnitario: '10,00',
      },
    ]);
    const conversion = [
      {
        entradaSaida: 'Credito',
        data: '03/02/2025',
        movimentacao: 'Atualização',
        produto: 'AXIA3 - Axia ON',
        instituicao: 'CORRETORA TESTE',
        quantidade: '260',
        precoUnitario: '-',
        valorOperacao: '-',
      },
    ];
    const first = await importFile(conversion);

    const { rows: legs } = await migratorPool.query<{
      id: string;
      type: string;
      natural_key: string;
      conversion_group_id: string;
      cost_basis: string | null;
      total_value: string;
    }>(
      `SELECT id, type, natural_key, conversion_group_id, cost_basis, total_value
         FROM transactions WHERE conversion_group_id IS NOT NULL ORDER BY type`,
    );
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((row) => row.conversion_group_id))).toHaveLength(1);
    expect(legs.map((row) => row.type)).toEqual(['conversion_in', 'conversion_out']);
    expect(legs.find((row) => row.type === 'conversion_in')?.cost_basis).toBe('2600.00000000');
    expect(legs.every((row) => row.total_value === '0.00000000')).toBe(true);
    const { rows: firstEvidence } = await migratorPool.query(
      'SELECT classification, natural_key FROM import_rows WHERE batch_id = $1',
      [first],
    );
    expect(firstEvidence).toEqual([{ classification: 'new', natural_key: legs[0]?.natural_key }]);

    await importFile(conversion);
    const { rows: after } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE conversion_group_id IS NOT NULL',
    );
    expect(Number(after[0]?.n)).toBe(2);
    const { rows: positions } = await migratorPool.query(
      `SELECT a.code, p.quantity, p.total_cost, p.realized_gain
         FROM positions p JOIN assets a ON a.id = p.asset_id
        WHERE a.code IN ('ELET3', 'AXIA3') ORDER BY a.code`,
    );
    expect(positions).toEqual([
      {
        code: 'AXIA3',
        quantity: '260.00000000',
        total_cost: '2600.00000000',
        realized_gain: '0.00000000',
      },
      {
        code: 'ELET3',
        quantity: '0.00000000',
        total_cost: '0.00000000',
        realized_gain: '0.00000000',
      },
    ]);
  });

  it('BR-005-20c: commits the observed KLBN11 one-to-many transfer evidence as one group', async () => {
    const importFile = async (rows: Parameters<typeof buildMovimentacaoXlsx>[0]) => {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(uploadDir, batchId, await buildMovimentacaoXlsx(rows));
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit({ batchId, userId }, handlerDeps());
    };
    await importFile([
      {
        entradaSaida: 'Credito',
        data: '19/12/2025',
        movimentacao: 'Compra',
        produto: 'KLBN11 - Klabin Units',
        instituicao: 'CORRETORA TESTE',
        quantidade: '0,6',
        precoUnitario: '10,00',
      },
    ]);
    const conversion = [
      {
        entradaSaida: 'Debito',
        data: '23/12/2025',
        movimentacao: 'Transferência',
        produto: 'KLBN11 - Klabin Units',
        instituicao: 'CORRETORA TESTE',
        quantidade: '0,6',
        precoUnitario: '-',
      },
      {
        entradaSaida: 'Credito',
        data: '23/12/2025',
        movimentacao: 'Transferência',
        produto: 'KLBN3 - Klabin ON',
        instituicao: 'CORRETORA TESTE',
        quantidade: '0,6',
        precoUnitario: '-',
      },
      {
        entradaSaida: 'Credito',
        data: '23/12/2025',
        movimentacao: 'Transferência',
        produto: 'KLBN4 - Klabin PN',
        instituicao: 'CORRETORA TESTE',
        quantidade: '2',
        precoUnitario: '-',
      },
      {
        entradaSaida: 'Credito',
        data: '23/12/2025',
        movimentacao: 'Transferência',
        produto: 'KLBN4 - Klabin PN',
        instituicao: 'CORRETORA TESTE',
        quantidade: '0,4',
        precoUnitario: '-',
      },
    ];
    await importFile(conversion);

    const { rows: legs } = await migratorPool.query<{
      type: string;
      cost_basis: string;
    }>(
      `SELECT type, cost_basis FROM transactions
        WHERE conversion_group_id IS NOT NULL ORDER BY type DESC, cost_basis DESC`,
    );
    expect(legs).toEqual([
      { type: 'conversion_out', cost_basis: '6.00000000' },
      { type: 'conversion_in', cost_basis: '4.00000000' },
      { type: 'conversion_in', cost_basis: '1.20000000' },
      { type: 'conversion_in', cost_basis: '0.80000000' },
    ]);
    await importFile(conversion);
    const { rows: after } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE conversion_group_id IS NOT NULL',
    );
    expect(Number(after[0]?.n)).toBe(4);
  });

  /**
   * SPEC-005 BR-005-17 + BR-005-20 — the two rules meeting.
   *
   * A row B3 exports with a type the movement map does not know lands as
   * `unclassified`, keyed by `importNaturalKeyFor`, which appends the raw B3
   * type so two different unmapped movements cannot collide. Classifying it
   * used to rederive the key from the *new* type, producing a key the import
   * path can never compute again — so re-importing the identical file matched
   * nothing and inserted the row a second time.
   *
   * The user's own correction was what made their next import wrong, which is
   * why this is worth an integration test rather than a unit one: the defect
   * only exists where classification and staging meet the same row.
   */
  it('BR-005-17/20: classifying an unclassified row then re-importing the same file adds nothing', async () => {
    const file = [
      {
        data: '10/01/2026',
        movimentacao: 'Leilão de Fração',
        produto: 'ITSA4 - Itausa PN',
        quantidade: '7',
        precoUnitario: '9,80',
      },
    ];

    const first = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, first, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: first, userId }, handlerDeps());
    await handleImportCommit({ batchId: first, userId }, handlerDeps());

    const { rows: unclassified } = await migratorPool.query(
      "SELECT id, transaction_id FROM import_rows WHERE classification = 'unclassified'",
    );
    expect(unclassified).toHaveLength(1);

    // BR-005-20: the user says what it was.
    await withTenant(
      userId,
      async (tx) => {
        const deps = buildIngestionDeps(tx, userId, clock);
        const classified = await classifyImportRow(deps, {
          rowId: ImportRowId.of(unclassified[0]?.id as string),
          type: 'buy',
        });
        if (!classified.ok) throw new Error(`classify failed: ${classified.error.code}`);
      },
      appDb,
    );

    // The same export, imported again — nothing in the file changed.
    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: second, userId }, handlerDeps());
    await handleImportCommit({ batchId: second, userId }, handlerDeps());

    const { rows: txCount } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txCount[0]?.n)).toBe(1);
  });

  /**
   * SPEC-005 BR-005-01 — the onboarding guide asks for all three extracts,
   * and B3 records the same purchase in two of them: as `Compra` in
   * Negociação, and as `Transferência - Liquidação` (the settlement) in
   * Movimentação.
   *
   * While that settlement mapped to `transfer_in` — which
   * `core/positions/apply-transaction.ts` treats as an acquisition — the two
   * rows carried different movement types *and* different institutions
   * (Negociação states none), so BR-005-14's natural key saw two unrelated
   * trades and BR-005-15 never fired. The user's *patrimônio* doubled, on the
   * documented happy path, with nothing on screen to suggest it.
   */
  it('BR-005-01: a purchase present in both Movimentação and Negociação is held once', async () => {
    const movimentacao = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      movimentacao,
      await buildMovimentacaoXlsx([
        {
          data: '12/01/2026',
          movimentacao: 'Transferência - Liquidação',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '38,50',
        },
      ]),
    );
    await handleImportStage({ batchId: movimentacao, userId }, handlerDeps());
    await handleImportCommit({ batchId: movimentacao, userId }, handlerDeps());

    const negociacao = await newPendingBatch('b3_negociacao');
    await saveUploadedFile(
      uploadDir,
      negociacao,
      await buildNegociacaoXlsx([
        {
          data: '12/01/2026',
          tipo: 'Compra',
          codigo: 'PETR4',
          quantidade: '100',
          preco: '38,50',
        },
      ]),
    );
    await handleImportStage({ batchId: negociacao, userId }, handlerDeps());
    await handleImportCommit({ batchId: negociacao, userId }, handlerDeps());

    // The authoritative record is the only one that moved the position.
    const { rows: positions } = await migratorPool.query(
      'SELECT quantity::text AS q FROM positions WHERE user_id = $1',
      [userId],
    );
    expect(positions).toHaveLength(1);
    expect(positions[0]?.q).toBe('100.00000000');

    // BR-005-19 (amended, #110): the settlement row is stored, never discarded,
    // and ignored — no ledger row, nothing in Needs attention.
    const { rows: settlement } = await migratorPool.query(
      'SELECT classification, transaction_id FROM import_rows WHERE batch_id = $1',
      [movimentacao],
    );
    expect(settlement).toEqual([{ classification: 'ignored', transaction_id: null }]);
  });

  /**
   * BR-005-17 + BR-005-19 (amended, #110) + BR-005-20. A Movimentação-only user
   * classifies an ignored settlement by hand. Re-importing the identical file
   * stages it `ignored` again — it never enters the occurrence plan — so the
   * user's classification is not doubled.
   */
  it('BR-005-17/20 (#110): classifying an ignored row then re-importing the same file adds nothing', async () => {
    const file = [
      {
        data: '12/01/2026',
        movimentacao: 'Transferência - Liquidação',
        produto: 'PETR4 - Petrobras PN',
        quantidade: '100',
        precoUnitario: '38,50',
      },
    ];

    const first = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, first, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: first, userId }, handlerDeps());
    await handleImportCommit({ batchId: first, userId }, handlerDeps());

    const { rows: ignored } = await migratorPool.query(
      "SELECT id FROM import_rows WHERE classification = 'ignored'",
    );
    expect(ignored).toHaveLength(1);

    await withTenant(
      userId,
      async (tx) => {
        const deps = buildIngestionDeps(tx, userId, clock);
        const classified = await classifyImportRow(deps, {
          rowId: ImportRowId.of(ignored[0]?.id as string),
          type: 'buy',
        });
        if (!classified.ok) throw new Error(`classify failed: ${classified.error.code}`);
      },
      appDb,
    );

    const second = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, second, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: second, userId }, handlerDeps());
    await handleImportCommit({ batchId: second, userId }, handlerDeps());

    const { rows: positions } = await migratorPool.query(
      'SELECT quantity::text AS q FROM positions WHERE user_id = $1',
      [userId],
    );
    expect(positions).toEqual([{ q: '100.00000000' }]);
    const { rows: txCount } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txCount[0]?.n)).toBe(1);
    // Reported as already done, so there is nothing to classify a second time.
    const { rows: reimported } = await migratorPool.query(
      'SELECT classification FROM import_rows WHERE batch_id = $1',
      [second],
    );
    expect(reimported).toEqual([{ classification: 'duplicate' }]);
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

  /**
   * #63 / SPEC-005 BR-005-05 — the defect this issue exists to fix.
   *
   * Before the fix, `handleImportStage` threw on a parse failure before any
   * `deleteUploadedFile` call: the batch stayed `pending` forever and the
   * uploaded `.xlsx` — the one artefact in the system still holding a raw CPF
   * (DL-005-07) — sat on disk with nothing but a manual cancel able to remove
   * it. A parse failure is also deterministic (reparsing the identical bytes
   * fails identically), so pg-boss's one configured retry of `import.stage`
   * was pure waste on top of the exposure.
   *
   * The malformed cell here is a `Data` value in ISO form (`2026-01-10`)
   * where B3 always writes `DD/MM/YYYY` — structurally a valid Movimentação
   * file (every header matches), which is exactly the case that used to
   * escape as a raw `TypeError` from `parseBrDate` rather than the
   * `DomainError` `IngestionPort.parse` promises.
   */
  it('BR-005-05/#63: a malformed cell fails the batch terminally, deletes the file, and leaves nothing retryable', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          data: '2026-01-10', // BR-005-04 structure is fine; BR-005-05's format is not.
          movimentacao: 'Compra',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '32,15',
        },
      ]),
    );

    // The whole point: this used to throw a raw TypeError. It must now
    // resolve normally — that is what tells pg-boss the job is done rather
    // than something to redeliver.
    await expect(handleImportStage({ batchId, userId }, handlerDeps())).resolves.toBeUndefined();

    const { rows: batchRows } = await migratorPool.query(
      'SELECT status, failure_code FROM import_batches WHERE id = $1',
      [batchId],
    );
    expect(batchRows[0]?.status).toBe('failed');
    expect(batchRows[0]?.failure_code).toBe('INGESTION_MALFORMED_CELL');

    // Nothing was staged — the parse never produced a record to stage.
    const { rows: rowsAfter } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM import_rows WHERE batch_id = $1',
      [batchId],
    );
    expect(Number(rowsAfter[0]?.n)).toBe(0);
    const { rows: txAfter } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM transactions',
    );
    expect(Number(txAfter[0]?.n)).toBe(0);

    // DL-005-07: the CPF-bearing file is gone — deleted in the same step
    // that recorded the failure, not left for a manual cancel to clean up.
    await expect(readFile(join(uploadDir, `${batchId}.xlsx`))).rejects.toThrow();

    // "Nothing left retryable": a redelivered `import.stage` (the only way
    // this could run again) now fails at the file read, not at the parse —
    // there is no CPF-bearing bytes left anywhere for it to reprocess.
    await expect(handleImportStage({ batchId, userId }, handlerDeps())).rejects.toThrow();
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
          return commitBatch({ ...deps, positions: throwingPositions }, userId, {
            batchId,
            corporateEventWindows: TEST_CORPORATE_EVENT_WINDOWS,
            assetConversionWindowDays: 45,
            assetConversionsEnabled: true,
          });
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
      await buildPosicaoXlsx({
        Acoes: [{ produto: 'PETR4 - PETROBRAS', codigo: 'PETR4', quantidade: '100' }],
      }),
    );
    await handleImportStage({ batchId: cleanBatch, userId }, handlerDeps());
    // BR-005-22 (amended, #108): the reference date the user confirmed.
    await handleImportCommit({ batchId: cleanBatch, userId, asOf: '2026-01-20' }, handlerDeps());
    const clean = await batchRow(cleanBatch);
    expect((clean?.reconciliation as { status: string } | null)?.status).toBe('reconciled');

    // An induced discrepancy: B3 shows 90, the ledger computes 100 — a
    // surplus with no unclassified row to blame reads as an uncaptured
    // corporate event (BR-005-24).
    const discrepantBatch = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      discrepantBatch,
      await buildPosicaoXlsx({
        Acoes: [{ produto: 'PETR4 - PETROBRAS', codigo: 'PETR4', quantidade: '90' }],
      }),
    );
    await handleImportStage({ batchId: discrepantBatch, userId }, handlerDeps());
    await handleImportCommit(
      { batchId: discrepantBatch, userId, asOf: '2026-01-20' },
      handlerDeps(),
    );
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

  /**
   * SPEC-005 BR-005-25 (#110) — the owner's morning: a Posição committed into
   * an empty ledger, its figures accepted, and every position doubled when the
   * history arrived. Accepting is refused with no history, and refused again
   * once history has made the stored difference stale.
   */
  it('BR-005-25 (#110): accepting B3’s figure is refused with no history, and when history made the report stale', async () => {
    const posicao = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      posicao,
      await buildPosicaoXlsx({
        Acoes: [{ produto: 'PETR4 - PETROBRAS', codigo: 'PETR4', quantidade: '100' }],
      }),
    );
    await handleImportStage({ batchId: posicao, userId }, handlerDeps());
    await handleImportCommit({ batchId: posicao, userId, asOf: '2026-01-20' }, handlerDeps());
    const report = (await batchRow(posicao))?.reconciliation as {
      discrepancies: { assetId: string; institutionId: string | null; computedQuantity: string }[];
    };
    const [discrepancy] = report.discrepancies;
    expect(discrepancy?.computedQuantity).toBe('0');

    const institutionId = discrepancy?.institutionId ?? null;
    const accept = () =>
      withTenant(
        userId,
        async (tx) =>
          acceptReconciliationAdjustment(buildIngestionDeps(tx, userId, clock), userId, {
            batchId: posicao,
            assetId: AssetId.of(discrepancy?.assetId as string),
            institutionId: institutionId === null ? null : InstitutionId.of(institutionId),
          }),
        appDb,
      );
    const countTransactions = async () =>
      Number((await migratorPool.query('SELECT count(*)::int AS n FROM transactions')).rows[0]?.n);

    const noHistory = await accept();
    expect(noHistory.ok || noHistory.error.code).toBe('IMPORT_ADJUSTMENT_NO_HISTORY');
    expect(await countTransactions()).toBe(0);

    // The history arrives: the 100 were bought on 10/01, before the report's date.
    const history = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      history,
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
    await handleImportStage({ batchId: history, userId }, handlerDeps());
    await handleImportCommit({ batchId: history, userId }, handlerDeps());

    // The stored +100 would now make 200.
    const stale = await accept();
    expect(stale.ok || stale.error.code).toBe('IMPORT_ADJUSTMENT_STALE');
    expect(await countTransactions()).toBe(1);
    const after = (await batchRow(posicao))?.reconciliation as {
      discrepancies: { resolved: boolean }[];
    };
    expect(after.discrepancies[0]?.resolved).toBe(false);
  });

  it('BR-005-06/AC: a CDB Posição row creates a fixed_income_contracts row the valuation reader can find', async () => {
    const batchId = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildPosicaoXlsx({
        'Renda Fixa': [
          {
            produto: 'CDB - BANCO TESTE S/A',
            codigo: 'CDB0000TESTE',
            quantidade: '1',
            indexador: 'CDI',
            dataEmissao: '01/01/2024',
          },
        ],
      }),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());

    // BR-005-22 (amended, #108): a Posição commit without the confirmed
    // reference date is refused before it writes anything.
    await expect(handleImportCommit({ batchId, userId }, handlerDeps())).rejects.toThrow(
      'IMPORT_REFERENCE_DATE_REQUIRED',
    );
    expect((await batchRow(batchId))?.status).toBe('previewed');

    await handleImportCommit({ batchId, userId, asOf: '2026-01-20' }, handlerDeps());

    const { rows: assetRows } = await migratorPool.query(
      "SELECT id FROM assets WHERE code = 'CDB0000TESTE'",
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
    // BR-005-06 (amended, #108): no rate on the real tab — the contract waits
    // for the user to type it (BR-009-13, valued at cost until then).
    expect(contract?.ratePercent).toBeNull();
  });

  describe('#115 — bank paper coded the same in Movimentação and Posição', () => {
    const application = {
      data: '10/01/2026',
      movimentacao: 'APLICAÇÃO',
      produto: 'CDB - CDB0000TESTE - BANCO TESTE S/A',
      quantidade: '1',
      precoUnitario: '50.000,00',
    };
    const snapshotOf = (quantidade: string) => ({
      'Renda Fixa': [
        {
          produto: 'CDB - BANCO TESTE S/A',
          codigo: 'CDB0000TESTE',
          quantidade,
          indexador: 'CDI',
          dataEmissao: '10/01/2026',
        },
      ],
    });
    const snapshot = snapshotOf('1');

    async function importFile(
      source: ImportBatch['source'],
      file: Uint8Array,
      asOf?: string,
    ): Promise<ImportBatchId> {
      const batchId = await newPendingBatch(source);
      await saveUploadedFile(uploadDir, batchId, file);
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit(
        asOf === undefined ? { batchId, userId } : { batchId, userId, asOf },
        handlerDeps(),
      );
      return batchId;
    }

    const reconciliationOf = async (batchId: ImportBatchId) =>
      (await batchRow(batchId))?.reconciliation as {
        status: string;
        discrepancies: { computedQuantity: string }[];
      } | null;

    const countTransactions = async () =>
      Number((await migratorPool.query('SELECT count(*)::int AS n FROM transactions')).rows[0]?.n);

    const runMerge = async () =>
      migratorPool.query(
        await readFile(
          join(process.cwd(), 'src/db/migrations/0020_merge_bank_paper_assets.sql'),
          'utf8',
        ),
      );

    /**
     * What the pre-#115 parser left: the asset and its staged rows under the
     * whole `Produto`. Keys name the asset by id, so they are already exact.
     */
    const makeLegacy = async (legacyCode: string): Promise<string> => {
      const { rows } = await migratorPool.query(
        "UPDATE assets SET code = $1 WHERE code = 'CDB0000TESTE' RETURNING id",
        [legacyCode],
      );
      const id = rows[0]?.id as string;
      await migratorPool.query(
        "UPDATE import_rows SET parsed_payload = jsonb_set(parsed_payload, '{assetCode}', to_jsonb($1::text)) WHERE asset_id = $2",
        [legacyCode, id],
      );
      return id;
    };

    it('BR-005-22..24: a CDB applied in Movimentação reconciles against Posição', async () => {
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application]));
      const posicao = await importFile(
        'b3_posicao',
        await buildPosicaoXlsx(snapshot),
        '2026-01-20',
      );

      expect((await reconciliationOf(posicao))?.status).toBe('reconciled');
      const { rows } = await migratorPool.query("SELECT code FROM assets WHERE class = 'cdb'");
      expect(rows.map((row) => row.code)).toEqual(['CDB0000TESTE']);
    });

    /**
     * The owner's ledger: applications imported before the parser read the
     * code, a Posição on the code, and a wallet holding the paper. The legacy
     * state is reproduced by renaming the asset — every key names it by id, so
     * that is exactly what the old parser left.
     */
    it('BR-005-17: 0020 merges a mis-coded asset, and re-importing both extracts adds nothing', async () => {
      // Two genuine applications on one day — occurrences 1 and 2.
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application, application]));
      const legacyId = await makeLegacy('CDB - CDB0000TESTE - BANCO TESTE S/A');

      const wallet = await withTenant(
        userId,
        async (tx) => {
          const deps = buildWalletDeps(tx, userId, clock);
          const created = await createWallet(deps, userId, { name: 'Reserva' });
          if (!created.ok) throw new Error('wallet setup failed');
          await allocateToWallet(deps, userId, {
            walletId: created.value.id,
            assetId: AssetId.of(legacyId),
          });
          return created.value;
        },
        appDb,
      );

      const before = await importFile('b3_posicao', await buildPosicaoXlsx(snapshot), '2026-01-20');
      expect((await reconciliationOf(before))?.discrepancies[0]?.computedQuantity).toBe('0');

      await runMerge();

      const { rows: canonical } = await migratorPool.query(
        "SELECT id FROM assets WHERE code = 'CDB0000TESTE'",
      );
      const canonicalId = canonical[0]?.id as string;
      const { rows: legacyLeft } = await migratorPool.query('SELECT 1 FROM assets WHERE id = $1', [
        legacyId,
      ]);
      expect(legacyLeft).toHaveLength(0);

      const { rows: ledger } = await migratorPool.query(
        'SELECT asset_id, natural_key, occurrence FROM transactions ORDER BY occurrence',
      );
      expect(ledger.map((row) => [row.asset_id, row.occurrence])).toEqual([
        [canonicalId, 1],
        [canonicalId, 2],
      ]);
      for (const row of ledger) expect(row.natural_key).toContain(canonicalId);

      const { rows: held } = await migratorPool.query(
        'SELECT asset_id, quantity::text AS q FROM positions',
      );
      expect(held).toEqual([{ asset_id: canonicalId, q: '2.00000000' }]);
      const { rows: allocated } = await migratorPool.query(
        'SELECT asset_id FROM wallet_allocations WHERE wallet_id = $1',
        [wallet.id],
      );
      expect(allocated).toEqual([{ asset_id: canonicalId }]);
      const { rows: events } = await migratorPool.query(
        'SELECT DISTINCT asset_id FROM wallet_allocation_events',
      );
      expect(events).toEqual([{ asset_id: canonicalId }]);
      // The stored report no longer names the deleted asset.
      expect(JSON.stringify(await reconciliationOf(before))).not.toContain(legacyId);
      const { rows: contracts } = await migratorPool.query(
        'SELECT asset_id FROM fixed_income_contracts',
      );
      expect(contracts).toEqual([{ asset_id: canonicalId }]);
      const { rows: staged } = await migratorPool.query(
        "SELECT DISTINCT asset_id, parsed_payload->>'assetCode' AS code FROM import_rows",
      );
      expect(staged).toEqual([{ asset_id: canonicalId, code: 'CDB0000TESTE' }]);

      // The migration is a no-op once merged.
      await runMerge();

      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application, application]));
      expect(await countTransactions()).toBe(2);

      const after = await importFile(
        'b3_posicao',
        await buildPosicaoXlsx(snapshotOf('2')),
        '2026-01-21',
      );
      expect((await reconciliationOf(after))?.status).toBe('reconciled');

      // The ledger still rebuilds to the position it caches.
      const verified = await withTenant(
        userId,
        async (tx) =>
          verifyPositions({
            transactions: new DrizzleTransactionRepository(tx, userId),
            positions: new DrizzlePositionRepository(tx, userId),
          }),
        appDb,
      );
      expect(verified.ok && verified.value.drift).toEqual([]);
    });

    it('0020 renames a mis-coded asset when no Posição has coded it yet', async () => {
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application]));
      const legacyId = await makeLegacy('CDB - CDB0000TESTE');

      await runMerge();

      const { rows } = await migratorPool.query("SELECT id, code FROM assets WHERE class = 'cdb'");
      expect(rows).toEqual([{ id: legacyId, code: 'CDB0000TESTE' }]);
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application]));
      expect(await countTransactions()).toBe(1);
    });

    it('0020 writes nothing when a key clashes with its canonical asset', async () => {
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application]));
      const legacyId = await makeLegacy('CDB - CDB0000TESTE');
      // The same application imported again on a fresh canonical asset.
      await importFile('b3_movimentacao', await buildMovimentacaoXlsx([application]));
      const ledgerBefore = (
        await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id')
      ).rows;
      expect(ledgerBefore).toHaveLength(2);

      await expect(runMerge()).rejects.toThrow(/#115/);
      const { rows } = await migratorPool.query('SELECT 1 FROM assets WHERE id = $1', [legacyId]);
      expect(rows).toHaveLength(1);
      const ledgerAfter = (
        await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id')
      ).rows;
      expect(ledgerAfter).toEqual(ledgerBefore);
    });
  });

  /**
   * #108 — Movimentação and Negociação only *guess* an asset's class from its
   * ticker; Posição *states* it. `DrizzleAssetResolver` used to overwrite the
   * class on every resolve, so importing a Movimentação after a Posição turned
   * a unit like TAEE11 back into a FII and a Negociação replaced its name with
   * the bare ticker.
   */
  it('#108: a Movimentação or Negociação guess never overwrites the class Posição stated, and a bare ticker never replaces a name', async () => {
    const posicao = await newPendingBatch('b3_posicao');
    await saveUploadedFile(
      uploadDir,
      posicao,
      await buildPosicaoXlsx({
        Acoes: [{ produto: 'TAEE11 - TAESA S.A.', codigo: 'TAEE11', quantidade: '10' }],
      }),
    );
    await handleImportStage({ batchId: posicao, userId }, handlerDeps());
    await handleImportCommit({ batchId: posicao, userId, asOf: '2026-01-20' }, handlerDeps());

    const movimentacao = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      movimentacao,
      await buildMovimentacaoXlsx([
        {
          data: '15/01/2026',
          movimentacao: 'Rendimento',
          produto: 'TAEE11 - TAESA UNT',
          quantidade: '10',
          precoUnitario: '0,10',
        },
      ]),
    );
    await handleImportStage({ batchId: movimentacao, userId }, handlerDeps());

    const negociacao = await newPendingBatch('b3_negociacao');
    await saveUploadedFile(
      uploadDir,
      negociacao,
      await buildNegociacaoXlsx([
        { data: '10/01/2026', tipo: 'Compra', codigo: 'TAEE11F', quantidade: '10', preco: '20,00' },
      ]),
    );
    await handleImportStage({ batchId: negociacao, userId }, handlerDeps());

    const { rows } = await migratorPool.query(
      "SELECT class AS asset_class, name FROM assets WHERE code = 'TAEE11'",
    );
    // Class: Posição's `stock` survives both guesses (`fii` from the `11`
    // ending). Name: Movimentação states one, so it may replace Posição's; the
    // later Negociação has only the ticker and must not replace either.
    expect(rows).toEqual([{ asset_class: 'stock', name: 'TAESA UNT' }]);
  });

  it('#108: Movimentação names an asset Negociação created with only its ticker, and keeps the guessed class', async () => {
    const negociacao = await newPendingBatch('b3_negociacao');
    await saveUploadedFile(
      uploadDir,
      negociacao,
      await buildNegociacaoXlsx([
        { data: '10/01/2026', tipo: 'Compra', codigo: 'VALE3', quantidade: '10', preco: '60,00' },
      ]),
    );
    await handleImportStage({ batchId: negociacao, userId }, handlerDeps());

    const movimentacao = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      movimentacao,
      await buildMovimentacaoXlsx([
        {
          data: '15/01/2026',
          movimentacao: 'Dividendo',
          produto: 'VALE3 - VALE S.A.',
          quantidade: '10',
          precoUnitario: '1,00',
        },
      ]),
    );
    await handleImportStage({ batchId: movimentacao, userId }, handlerDeps());

    const { rows } = await migratorPool.query(
      "SELECT class AS asset_class, name FROM assets WHERE code = 'VALE3'",
    );
    expect(rows).toEqual([{ asset_class: 'stock', name: 'VALE S.A.' }]);
  });

  it('#108: a Movimentação transfer with no price stays out of the ledger as unclassified', async () => {
    const batchId = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(
      uploadDir,
      batchId,
      await buildMovimentacaoXlsx([
        {
          entradaSaida: 'Credito',
          data: '10/01/2026',
          movimentacao: 'Transferência',
          produto: 'PETR4 - Petrobras PN',
          quantidade: '100',
          precoUnitario: '-',
          valorOperacao: '-',
        },
      ]),
    );
    await handleImportStage({ batchId, userId }, handlerDeps());
    await handleImportCommit({ batchId, userId }, handlerDeps());

    const { rows: positions } = await migratorPool.query(
      'SELECT count(*)::int AS n FROM positions WHERE user_id = $1',
      [userId],
    );
    expect(Number(positions[0]?.n)).toBe(0);
    const { rows: staged } = await migratorPool.query(
      'SELECT classification FROM import_rows WHERE batch_id = $1',
      [batchId],
    );
    expect(staged).toEqual([{ classification: 'unclassified' }]);
  });

  /**
   * SPEC-005 BR-005-20a (#110) — import order must not decide the outcome.
   * A transfer imported before its source broker's history commits
   * `unclassified`; once the history is in, re-importing the same file gives
   * that transaction its carried cost in place rather than adding a copy.
   */
  it('BR-005-20a (#110): a transfer imported before its source history is promoted in place on re-import', async () => {
    const transferFile = [
      {
        entradaSaida: 'Credito',
        data: '10/03/2026',
        movimentacao: 'Transferência',
        produto: 'PETR4 - Petrobras PN',
        instituicao: 'CORRETORA DESTINO',
        quantidade: '100',
        precoUnitario: '-',
        valorOperacao: '-',
      },
      {
        entradaSaida: 'Debito',
        data: '10/03/2026',
        movimentacao: 'Transferência',
        produto: 'PETR4 - Petrobras PN',
        instituicao: 'CORRETORA ORIGEM',
        quantidade: '100',
        precoUnitario: '-',
        valorOperacao: '-',
      },
    ];
    async function importFile(rows: Parameters<typeof buildMovimentacaoXlsx>[0]) {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(uploadDir, batchId, await buildMovimentacaoXlsx(rows));
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit({ batchId, userId }, handlerDeps());
      return batchId;
    }

    // No source history yet: the debit cannot leave ORIGEM, the credit waits.
    const first = await importFile(transferFile);
    const { rows: waiting } = await migratorPool.query(
      "SELECT id, natural_key, status FROM transactions WHERE type = 'transfer_in'",
    );
    expect(waiting).toEqual([expect.objectContaining({ status: 'unclassified' })]);

    // ORIGEM's history: 100 bought at 10,00, no fees → cost 1.000,00, preço médio 10,00.
    await importFile([
      {
        entradaSaida: 'Credito',
        data: '05/01/2026',
        movimentacao: 'Compra',
        produto: 'PETR4 - Petrobras PN',
        instituicao: 'CORRETORA ORIGEM',
        quantidade: '100',
        precoUnitario: '10,00',
      },
    ]);

    await importFile(transferFile);

    const { rows: promoted } = await migratorPool.query(
      "SELECT id, natural_key, occurrence, status, unit_price, is_user_modified FROM transactions WHERE type = 'transfer_in'",
    );
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      id: waiting[0]?.id,
      natural_key: waiting[0]?.natural_key,
      status: 'active',
      is_user_modified: false,
      unit_price: '10.00000000',
    });
    const { rows: total } = await migratorPool.query('SELECT count(*)::int AS n FROM transactions');
    // The buy, the debit written on re-import, and the one promoted credit.
    expect(Number(total[0]?.n)).toBe(3);

    // DESTINO: 100 × 10,00 = 1.000,00.
    const { rows: destination } = await migratorPool.query(
      'SELECT quantity, average_cost, total_cost FROM positions WHERE institution_id = $1',
      [promoted[0]?.institution_id ?? (await transferInInstitution())],
    );
    expect(destination).toEqual([
      { quantity: '100.00000000', average_cost: '10.00000000', total_cost: '1000.00000000' },
    ]);

    // The row that first staged it has left Needs attention.
    const { rows: origin } = await migratorPool.query(
      'SELECT classification FROM import_rows WHERE batch_id = $1 AND transaction_id = $2',
      [first, waiting[0]?.id],
    );
    expect(origin).toEqual([{ classification: 'new' }]);

    async function transferInInstitution() {
      const { rows } = await migratorPool.query(
        "SELECT institution_id FROM transactions WHERE type = 'transfer_in'",
      );
      return rows[0]?.institution_id as string;
    }
  });

  describe('BR-005-20a — several carries into one position, and re-carry (#110 review, #112)', () => {
    const row = (
      direction: 'Credito' | 'Debito',
      data: string,
      instituicao: string,
      quantidade: string,
    ) => ({
      entradaSaida: direction,
      data,
      movimentacao: 'Transferência',
      produto: 'PETR4 - Petrobras PN',
      instituicao,
      quantidade,
      precoUnitario: '-',
      valorOperacao: '-',
    });
    const buyAt = (instituicao: string, data: string, quantidade: string, preco: string) => ({
      entradaSaida: 'Credito',
      data,
      movimentacao: 'Compra',
      produto: 'PETR4 - Petrobras PN',
      instituicao,
      quantidade,
      precoUnitario: preco,
    });

    async function importFile(rows: Parameters<typeof buildMovimentacaoXlsx>[0]) {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(uploadDir, batchId, await buildMovimentacaoXlsx(rows));
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit({ batchId, userId }, handlerDeps());
      return batchId;
    }

    async function positionOfCreditInto(quantity: string) {
      const { rows } = await migratorPool.query(
        `SELECT p.quantity, p.average_cost, p.total_cost FROM positions p
           JOIN transactions t ON t.institution_id = p.institution_id AND t.asset_id = p.asset_id
          WHERE t.type = 'transfer_in' AND t.quantity = $1`,
        [quantity],
      );
      return rows[0];
    }

    it('promotes two credits into one position that a later transfer needs both of, and fixes the first batch’s counts', async () => {
      const file = [
        row('Credito', '10/03/2026', 'CORRETORA B', '100'),
        row('Debito', '10/03/2026', 'CORRETORA A', '100'),
        row('Credito', '10/03/2026', 'CORRETORA B', '50'),
        row('Debito', '10/03/2026', 'CORRETORA C', '50'),
        row('Credito', '12/03/2026', 'CORRETORA D', '150'),
        row('Debito', '12/03/2026', 'CORRETORA B', '150'),
      ];
      const first = await importFile(file);

      // A: 100 @ 10,00 = 1.000,00. C: 50 @ 16,00 = 800,00.
      await importFile([
        buyAt('CORRETORA A', '05/01/2026', '100', '10,00'),
        buyAt('CORRETORA C', '05/01/2026', '50', '16,00'),
      ]);
      const again = await importFile(file);

      expect((await batchRow(again))?.status).toBe('committed');
      const { rows: credits } = await migratorPool.query(
        "SELECT status FROM transactions WHERE type = 'transfer_in'",
      );
      expect(credits.map((c) => c.status)).toEqual(['active', 'active', 'active']);
      // D carries (1.000,00 + 800,00) ÷ 150 = 12,00.
      expect(await positionOfCreditInto('150')).toEqual({
        quantity: '150.00000000',
        average_cost: '12.00000000',
        total_cost: '1800.00000000',
      });
      const counts = (await batchRow(first))?.row_counts as Record<string, number>;
      // #117: the three promoted credits are new; the three debits the first
      // commit refused, applied by the re-import, are duplicates.
      expect(counts).toMatchObject({ new: 3, duplicates: 3, needsAttention: 0 });
    });

    it('re-imports a transfer after a backdated source buy and corrects the carried 10,00 to 15,00', async () => {
      const file = [
        row('Credito', '10/03/2026', 'CORRETORA DESTINO', '100'),
        row('Debito', '10/03/2026', 'CORRETORA ORIGEM', '100'),
      ];
      await importFile([buyAt('CORRETORA ORIGEM', '05/01/2026', '100', '10,00')]);
      await importFile(file);
      const { rows: carried } = await migratorPool.query(
        "SELECT id, natural_key, unit_price FROM transactions WHERE type = 'transfer_in'",
      );
      expect(carried[0]?.unit_price).toBe('10.00000000');

      await importFile([buyAt('CORRETORA ORIGEM', '01/02/2026', '100', '20,00')]);
      await importFile(file);

      // ORIGEM before 10/03: (1.000,00 + 2.000,00) ÷ 200 = 15,00.
      const { rows: recarried } = await migratorPool.query(
        "SELECT id, natural_key, unit_price, is_user_modified FROM transactions WHERE type = 'transfer_in'",
      );
      expect(recarried).toEqual([
        {
          id: carried[0]?.id,
          natural_key: carried[0]?.natural_key,
          unit_price: '15.00000000',
          is_user_modified: false,
        },
      ]);
      expect(await positionOfCreditInto('100')).toEqual({
        quantity: '100.00000000',
        average_cost: '15.00000000',
        total_cost: '1500.00000000',
      });
    });
  });

  /**
   * SPEC-005 BR-005-17..19 (#110) — the owner's path. A Movimentação committed
   * before map v3 stored a settlement mirror and an `APLICAÇÃO` as
   * `unclassified` transactions under the placeholder type and the raw B3 type.
   * Re-importing the same file supersedes the mirror, activates the
   * `APLICAÇÃO` as a buy, and empties Needs attention.
   */
  it('#110: a re-import supersedes mirrors and activates newly mapped rows an older map stored unclassified', async () => {
    const file = [
      {
        entradaSaida: 'Credito',
        data: '10/03/2026',
        movimentacao: 'Transferência - Liquidação',
        produto: 'PETR4 - Petrobras PN',
        instituicao: 'CORRETORA TESTE',
        quantidade: '100',
        precoUnitario: '32,15',
      },
      {
        entradaSaida: 'Credito',
        data: '10/03/2026',
        movimentacao: 'APLICAÇÃO',
        produto: 'VALE3 - Vale ON',
        instituicao: 'CORRETORA TESTE',
        quantidade: '100',
        precoUnitario: '10,00',
      },
    ];

    // This morning: staged by the real handler, then written as map v2 wrote it.
    const origin = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, origin, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: origin, userId }, handlerDeps());
    const seeded = await withTenant(
      userId,
      async (tx) => {
        const deps = buildIngestionDeps(tx, userId, clock);
        const staged = await deps.rows.listByBatch(origin);
        const byType = new Map<string, { rowId: string; transaction: Transaction }>();
        for (const row of staged) {
          if (row.record.kind !== 'transaction') continue;
          const record = row.record;
          const transaction: Transaction = {
            id: TransactionId.generate(),
            userId,
            assetId: row.assetId,
            institutionId: row.institutionId,
            type: UNCLASSIFIED_PLACEHOLDER_TYPE,
            status: 'unclassified',
            tradeDate: record.tradeDate,
            quantity: record.quantity,
            unitPrice: record.unitPrice,
            fees: record.fees,
            totalValue: computeTotalValue(
              UNCLASSIFIED_PLACEHOLDER_TYPE,
              record.quantity,
              record.unitPrice,
              record.fees,
            ),
            ratio: null,
            conversionGroupId: null,
            costBasis: null,
            naturalKey: importNaturalKeyFor(
              {
                assetId: row.assetId,
                institutionId: row.institutionId,
                type: UNCLASSIFIED_PLACEHOLDER_TYPE,
                tradeDate: record.tradeDate,
                quantity: record.quantity,
                unitPrice: record.unitPrice,
              },
              record.b3Type,
            ),
            occurrence: 1,
            importBatchId: origin,
            isManual: false,
            isUserModified: false,
            createdAt: clock.now(),
            updatedAt: clock.now(),
          };
          await deps.transactions.insert(transaction);
          byType.set(record.b3Type, { rowId: row.id, transaction });
        }
        return byType;
      },
      appDb,
    );
    for (const { rowId, transaction } of seeded.values()) {
      await migratorPool.query(
        `UPDATE import_rows SET classification = 'unclassified', natural_key = $1,
           occurrence = 1, ledger_type = $2, transaction_id = $3 WHERE id = $4`,
        [transaction.naturalKey, UNCLASSIFIED_PLACEHOLDER_TYPE, transaction.id, rowId],
      );
    }
    await migratorPool.query(
      `UPDATE import_batches SET status = 'committed',
         row_counts = row_counts || '{"new":0,"needsAttention":2,"ignored":0}'::jsonb
       WHERE id = $1`,
      [origin],
    );
    const mirror = seeded.get('Transferência - Liquidação')?.transaction as Transaction;
    const aplicacao = seeded.get('APLICAÇÃO')?.transaction as Transaction;

    // Today: the same file, through the real handlers.
    const again = await newPendingBatch('b3_movimentacao');
    await saveUploadedFile(uploadDir, again, await buildMovimentacaoXlsx(file));
    await handleImportStage({ batchId: again, userId }, handlerDeps());
    await handleImportCommit({ batchId: again, userId }, handlerDeps());

    expect((await batchRow(again))?.status).toBe('committed');
    const { rows: current } = await migratorPool.query(
      'SELECT classification FROM import_rows WHERE batch_id = $1',
      [again],
    );
    expect(current.map((r) => r.classification)).toEqual(['duplicate', 'duplicate']);

    const { rows: stored } = await migratorPool.query(
      'SELECT id, type, status, natural_key, is_user_modified FROM transactions ORDER BY status',
    );
    expect(stored).toEqual([
      {
        id: aplicacao.id,
        type: 'buy',
        status: 'active',
        natural_key: aplicacao.naturalKey,
        is_user_modified: false,
      },
      {
        id: mirror.id,
        type: UNCLASSIFIED_PLACEHOLDER_TYPE,
        status: 'superseded',
        natural_key: mirror.naturalKey,
        is_user_modified: false,
      },
    ]);

    // VALE3: 100 × 10,00 = 1.000,00 with no fees. PETR4: no position — a mirror moves nothing.
    const { rows: positions } = await migratorPool.query(
      'SELECT asset_id, quantity, average_cost, total_cost FROM positions',
    );
    expect(positions).toEqual([
      {
        asset_id: aplicacao.assetId,
        quantity: '100.00000000',
        average_cost: '10.00000000',
        total_cost: '1000.00000000',
      },
    ]);

    const { rows: originRows } = await migratorPool.query(
      'SELECT transaction_id, classification FROM import_rows WHERE batch_id = $1 ORDER BY classification',
      [origin],
    );
    expect(originRows).toEqual([
      { transaction_id: mirror.id, classification: 'ignored' },
      { transaction_id: aplicacao.id, classification: 'new' },
    ]);
    expect((await batchRow(origin))?.row_counts).toMatchObject({
      new: 1,
      needsAttention: 0,
      ignored: 1,
    });
    // The dashboard's Needs attention queue reads `import_rows.classification`.
    const attention = await withTenant(
      userId,
      async (tx) => new DrizzleImportRowRepository(tx, userId).countNeedsAttentionByBatch(),
      appDb,
    );
    expect(attention).toEqual([]);
  });

  it('#117: one transfer debit with no holding no longer discards the asset’s proventos, and a re-import applies it once', async () => {
    const produto = 'HGLG11 - CSHG Logística';
    const file = [
      {
        entradaSaida: 'Credito',
        data: '13/02/2026',
        movimentacao: 'Rendimento',
        produto,
        instituicao: 'CORRETORA ORIGEM',
        quantidade: '10',
        precoUnitario: '1,10',
        valorOperacao: '11,00',
      },
      {
        entradaSaida: 'Debito',
        data: '20/02/2026',
        movimentacao: 'Transferência',
        produto,
        instituicao: 'CORRETORA ORIGEM',
        quantidade: '10',
        precoUnitario: '-',
        valorOperacao: '-',
      },
    ];
    async function importFile(rows: Parameters<typeof buildMovimentacaoXlsx>[0]) {
      const batchId = await newPendingBatch('b3_movimentacao');
      await saveUploadedFile(uploadDir, batchId, await buildMovimentacaoXlsx(rows));
      await handleImportStage({ batchId, userId }, handlerDeps());
      await handleImportCommit({ batchId, userId }, handlerDeps());
      return batchId;
    }
    const ledgerTypes = async () =>
      (await migratorPool.query('SELECT type FROM transactions ORDER BY type')).rows.map(
        (row) => row.type as string,
      );
    const classifications = async (batchId: ImportBatchId) =>
      (
        await migratorPool.query(
          'SELECT classification FROM import_rows WHERE batch_id = $1 ORDER BY classification',
          [batchId],
        )
      ).rows.map((row) => row.classification as string);

    // No holding at ORIGEM: only the debit is refused; the provento applies.
    const first = await importFile(file);
    expect(await ledgerTypes()).toEqual(['rendimento']);
    expect(await classifications(first)).toEqual(['invalid', 'new']);
    expect((await batchRow(first))?.row_counts).toMatchObject({ new: 1, needsAttention: 1 });

    // ORIGEM's history: 10 bought at 160,00.
    await importFile([
      {
        entradaSaida: 'Credito',
        data: '05/01/2026',
        movimentacao: 'Compra',
        produto,
        instituicao: 'CORRETORA ORIGEM',
        quantidade: '10',
        precoUnitario: '160,00',
      },
    ]);

    // BR-005-17: the re-import applies the refused debit once, and the first
    // batch's copy leaves Needs attention.
    await importFile(file);
    expect(await ledgerTypes()).toEqual(['buy', 'rendimento', 'transfer_out']);
    expect(await classifications(first)).toEqual(['duplicate', 'new']);
    expect((await batchRow(first))?.row_counts).toMatchObject({
      new: 1,
      duplicates: 1,
      needsAttention: 0,
    });

    await importFile(file);
    expect(await ledgerTypes()).toEqual(['buy', 'rendimento', 'transfer_out']);
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
