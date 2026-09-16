import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity, asStored } from '@/core/shared/money';
import { editTransaction } from '@/core/ledger/edit-transaction';
import {
  computeTotalValue,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
import { replayPosition } from '@/core/positions/replay';
import {
  type CorporateEventFactor,
  type CorporateEventFactorKind,
  factorMultiplier,
} from '@/core/quotes/corporate-event-factors';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import { UNCLASSIFIED_PLACEHOLDER_TYPE, importNaturalKeyFor } from '@/core/ingestion/occurrence';
import type {
  ImportBatch,
  ImportRow,
  NormalizedTransactionRecord,
  ParsedExtract,
  ParsedRecord,
} from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function buy(overrides: Partial<NormalizedTransactionRecord> = {}) {
  const record: NormalizedTransactionRecord = {
    kind: 'transaction',
    priceStated: true,
    b3Type: 'Compra',
    direction: null,
    assetCode: 'PETR4',
    assetName: 'Petrobras PN',
    assetClass: 'stock',
    institutionName: 'Corretora Teste',
    tradeDate: BusinessDate.of('2026-01-10'),
    quantity: Quantity.fromString('100'),
    unitPrice: Money.fromString('32.15'),
    fees: Money.fromString('4.90'),
    ratio: null,
    ...overrides,
  };
  return { raw: { Movimentação: record.b3Type }, record };
}

async function stagedBatch(
  deps: ReturnType<typeof buildFakeIngestionDeps>,
  extract: ParsedExtract,
) {
  const batchId = ImportBatchId.generate();
  deps.batches.seed({
    id: batchId,
    userId,
    source: extract.extractType,
    status: 'pending',
    uploadedAt: new Date(),
    committedAt: null,
    rowCounts: null,
    reconciliation: null,
    failureCode: null,
  });
  const staged = await stageBatch(deps, userId, { batchId, extract });
  if (!staged.ok) throw new Error('stage failed in test setup');
  return batchId;
}

describe('SPEC-005 BR-005-13 — commitBatch', () => {
  it('BR-005-13: applies new rows to the ledger and upserts the position', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy()],
    });

    const result = await commitBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(1);
    expect(deps.transactions.insertCount).toBe(1);
    expect(deps.transactions.rows[0]?.status).toBe('active');
    expect(deps.positions.upsertCount).toBe(1);
    expect(result.value.batch.status).toBe('committed');
  });

  it('BR-005-19: an unclassified row commits with status unclassified and does not affect the position', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy({ b3Type: 'Tipo Desconhecido' })],
    });

    const result = await commitBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.transactions.rows[0]?.status).toBe('unclassified');
    // Excluded from replay by status, so no position is created for it alone.
    expect(deps.positions.upsertCount).toBe(0);
  });

  it('BR-005-19 (amended, #110): an ignored row writes no transaction and blames nothing in reconciliation', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy({ b3Type: 'Transferência - Liquidação', direction: 'credit' }), buy()],
    });

    const result = await commitBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(1);
    expect(deps.transactions.rows).toHaveLength(1);
    const ignored = deps.rows.all.find((row) => row.classification === 'ignored');
    expect(ignored?.transactionId).toBeNull();
  });

  it('BR-005-15: a duplicate row is skipped — no new transaction, no position write', async () => {
    const deps = buildFakeIngestionDeps();
    const firstBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy()],
    });
    await commitBatch(deps, userId, { batchId: firstBatch });
    expect(deps.transactions.insertCount).toBe(1);

    const secondBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy()],
    });
    const result = await commitBatch(deps, userId, { batchId: secondBatch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(0);
    expect(result.value.skippedDuplicates).toBe(1);
    expect(deps.transactions.insertCount).toBe(1);
  });

  it('AR-19: committing an already-committed batch is an idempotent no-op, not an error', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records: [buy()] });
    await commitBatch(deps, userId, { batchId });
    expect(deps.transactions.insertCount).toBe(1);

    const retried = await commitBatch(deps, userId, { batchId });

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.applied).toBe(0);
    expect(deps.transactions.insertCount).toBe(1); // unchanged — no double-apply
  });

  it('refuses to commit a batch that has not been staged', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed({
      id: batchId,
      userId,
      source: 'b3_movimentacao',
      status: 'pending',
      uploadedAt: new Date(),
      committedAt: null,
      rowCounts: null,
      reconciliation: null,
      failureCode: null,
    });

    const result = await commitBatch(deps, userId, { batchId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_PREVIEWED');
  });

  it('BR-006-15/forgiving-of-user-error: a row that cannot be replayed is excluded and marked invalid, the rest of the batch still commits', async () => {
    const deps = buildFakeIngestionDeps();
    // A sell with no prior buy cannot be replayed for PETR4 — but VALE3's row
    // in the same batch is perfectly fine and must still commit.
    const valeAsset = await deps.assets.resolve({
      code: 'VALE3',
      name: 'Vale ON',
      assetClass: 'stock',
      classStated: false,
      nameStated: true,
    });
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        buy({ b3Type: 'Venda', assetCode: 'PETR4' }),
        buy({ assetCode: 'VALE3', assetName: 'Vale ON' }),
      ],
    });

    const result = await commitBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(1);
    expect(result.value.invalid).toBe(1);
    expect(deps.transactions.rows).toHaveLength(1);
    expect(deps.transactions.rows[0]?.assetId).toBe(valeAsset);

    const invalidRow = deps.rows.all.find((r) => r.classification === 'invalid');
    expect(invalidRow?.record.assetCode).toBe('PETR4');
  });

  it('BR-005-06/22: a Posição batch writes fixed-income contracts and produces a reconciliation report', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_posicao',
      records: [
        {
          raw: { Produto: 'CDB TESTE' },
          record: {
            kind: 'position',
            assetCode: 'CDB-TESTE',
            assetName: 'CDB Banco Teste',
            assetClass: 'cdb',
            institutionName: 'Banco Teste',
            quantity: Quantity.fromString('1'),
            fixedIncome: {
              indexer: 'cdi_percent',
              ratePercent: Quantity.fromString('110'),
              issueDate: BusinessDate.of('2024-01-01'),
              maturityDate: BusinessDate.of('2027-01-01'),
              principal: Money.fromString('10000'),
            },
          },
        },
      ],
    });

    const result = await commitBatch(deps, userId, {
      batchId,
      asOf: BusinessDate.of('2026-03-01'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.fixedIncomeContracts.calls).toHaveLength(1);
    expect(result.value.batch.reconciliation).not.toBeNull();
    // BR-005-22 (amended, #108): the date the user confirmed, not one read off the file.
    expect(result.value.batch.reconciliation?.asOf).toBe('2026-03-01');
    // The ledger holds none of this CDB — a clean discrepancy against B3's 1.
    expect(result.value.batch.reconciliation?.status).toBe('discrepancies_found');
    expect(result.value.batch.reconciliation?.discrepancies[0]?.cause).toBe(
      'missing_history_before_import_range',
    );
  });

  describe('BR-005-22 (amended, #108) — the Posição reference date is confirmed by the user', () => {
    const position = {
      raw: { Produto: 'PETR4 - PETROBRAS' },
      record: {
        kind: 'position' as const,
        assetCode: 'PETR4',
        assetName: 'PETROBRAS',
        assetClass: 'stock' as const,
        institutionName: 'Corretora Teste',
        quantity: Quantity.fromString('100'),
        fixedIncome: null,
      },
    };

    it('refuses a Posição commit with no reference date, writing nothing', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await stagedBatch(deps, { extractType: 'b3_posicao', records: [position] });

      const result = await commitBatch(deps, userId, { batchId });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('IMPORT_REFERENCE_DATE_REQUIRED');
      expect((await deps.batches.findById(batchId))?.status).toBe('previewed');
    });

    it('refuses a reference date after today', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await stagedBatch(deps, { extractType: 'b3_posicao', records: [position] });

      const result = await commitBatch(deps, userId, {
        batchId,
        asOf: BusinessDate.of('2999-01-01'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('IMPORT_REFERENCE_DATE_IN_FUTURE');
    });

    it('sums one asset held in two accounts at the same institution before comparing', async () => {
      const deps = buildFakeIngestionDeps();
      const history = await stagedBatch(deps, {
        extractType: 'b3_movimentacao',
        records: [buy({ tradeDate: BusinessDate.of('2026-01-10') })],
      });
      await commitBatch(deps, userId, { batchId: history });

      const accountA = {
        ...position,
        record: { ...position.record, quantity: Quantity.fromString('60') },
      };
      const accountB = {
        ...position,
        record: { ...position.record, quantity: Quantity.fromString('40') },
      };
      const batchId = await stagedBatch(deps, {
        extractType: 'b3_posicao',
        records: [accountA, accountB],
      });

      const result = await commitBatch(deps, userId, {
        batchId,
        asOf: BusinessDate.of('2026-03-01'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 60 + 40 against a ledger of 100: one clean position, not two discrepancies.
      expect(result.value.batch.reconciliation?.status).toBe('reconciled');
      expect(result.value.batch.reconciliation?.discrepancies).toHaveLength(0);
    });

    it('needs no reference date for a Movimentação batch', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records: [buy()] });

      const result = await commitBatch(deps, userId, { batchId });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.batch.reconciliation).toBeNull();
    });
  });
});

describe('SPEC-005 BR-005-20a (#110) — a price-less transfer carries its source cost at commit', () => {
  const ORIGEM = 'Corretora Origem';
  const DESTINO = 'Corretora Destino';
  const TERCEIRA = 'Corretora Terceira';
  const TRANSFER_DAY = BusinessDate.of('2026-03-10');

  const credit = (overrides: Partial<NormalizedTransactionRecord> = {}) =>
    buy({
      b3Type: 'Transferência',
      direction: 'credit',
      institutionName: DESTINO,
      tradeDate: TRANSFER_DAY,
      priceStated: false,
      unitPrice: Money.zero(),
      fees: Money.zero(),
      ...overrides,
    });
  const debit = (overrides: Partial<NormalizedTransactionRecord> = {}) =>
    credit({ direction: 'debit', institutionName: ORIGEM, ...overrides });
  /** The source's history: 100 bought at 10,00 with no fees → cost 1.000,00. */
  const history = (overrides: Partial<NormalizedTransactionRecord> = {}) =>
    buy({
      institutionName: ORIGEM,
      tradeDate: BusinessDate.of('2026-01-05'),
      unitPrice: Money.fromString('10'),
      fees: Money.zero(),
      ...overrides,
    });

  async function importFile(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId });
    if (!result.ok) throw new Error(`commit failed: ${result.error.code}`);
    return { batchId, outcome: result.value };
  }

  const transfersIn = (deps: FakeIngestionDeps) =>
    deps.transactions.rows.filter((t) => t.type === 'transfer_in');

  async function positionAt(deps: FakeIngestionDeps, institution: string | null) {
    const id = institution === null ? null : await deps.institutions.resolve(institution);
    const found = (await deps.positions.list()).find((p) => p.institutionId === id);
    return found === undefined
      ? undefined
      : {
          quantity: found.state.quantity.toString(),
          averageCost: found.state.averageCost.toString(),
          totalCost: found.state.totalCost.toString(),
        };
  }

  /** DM-4 / TS-08: every cached position equals a replay of the ledger behind it. */
  async function expectRebuildEqualsIncremental(deps: FakeIngestionDeps) {
    for (const snapshot of await deps.positions.list()) {
      const replayed = replayPosition(
        await deps.transactions.listForPosition(snapshot.assetId, snapshot.institutionId),
      );
      if (!replayed.ok) throw new Error('ledger does not replay');
      expect(replayed.value.quantity.toString()).toBe(snapshot.state.quantity.toString());
      expect(replayed.value.totalCost.toString()).toBe(snapshot.state.totalCost.toString());
      expect(replayed.value.averageCost.toString()).toBe(snapshot.state.averageCost.toString());
    }
  }

  /**
   * The owner's real state after #108: the file committed with the credit
   * `unclassified` at its placeholder zero, the debit active — what #108's
   * commit wrote before any carry existed.
   */
  async function commitAsIssue108(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const now = deps.clock.now();
    const staged = await deps.rows.listByBatch(batchId);
    const written: Transaction[] = staged.map((row) => {
      const record = row.record as NormalizedTransactionRecord;
      const type = row.ledgerType as TransactionType;
      return {
        id: TransactionId.generate(),
        userId,
        assetId: row.assetId,
        institutionId: row.institutionId,
        type,
        status: row.classification === 'unclassified' ? 'unclassified' : 'active',
        tradeDate: record.tradeDate,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
        fees: record.fees,
        totalValue: computeTotalValue(type, record.quantity, record.unitPrice, record.fees),
        ratio: null,
        naturalKey: row.naturalKey as string,
        occurrence: row.occurrence as number,
        importBatchId: batchId,
        isManual: false,
        isUserModified: false,
        createdAt: now,
        updatedAt: now,
      };
    });
    await deps.transactions.insertMany(written);
    // #108's commit refreshed each position it wrote to, as this does.
    for (const t of written) {
      const replayed = replayPosition(
        await deps.transactions.listForPosition(t.assetId, t.institutionId),
      );
      if (!replayed.ok) throw new Error('#108 state does not replay');
      await deps.positions.upsertMany([
        { assetId: t.assetId, institutionId: t.institutionId, state: replayed.value },
      ]);
    }
    await deps.rows.attachTransactions(
      new Map(staged.map((row, index) => [row.id, (written[index] as Transaction).id])),
    );
    const batch = (await deps.batches.findById(batchId)) as ImportBatch;
    await deps.batches.update({ ...batch, status: 'committed' });
    return batchId;
  }

  it('carries 1.000,00 ÷ 100 = 10,00 onto the credit, and a re-import changes nothing', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    const { batchId, outcome } = await importFile(deps, [credit(), debit()]);

    expect(outcome.applied).toBe(2);
    expect(transfersIn(deps)).toHaveLength(1);
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'active', isUserModified: false });
    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
    expect(await positionAt(deps, DESTINO)).toEqual({
      quantity: '100',
      averageCost: '10',
      totalCost: '1000',
    });
    // BR-005-19: carried, so no longer in Needs attention — row and batch counts both.
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['new', 'new']);
    expect(outcome.batch.rowCounts).toMatchObject({ new: 2, needsAttention: 0 });

    // BR-005-17: the same file again.
    const inserts = deps.transactions.insertCount;
    const again = await importFile(deps, [credit(), debit()]);
    expect(again.outcome).toMatchObject({ applied: 0, promoted: 0, skippedDuplicates: 2 });
    expect(deps.transactions.insertCount).toBe(inserts);
    await expectRebuildEqualsIncremental(deps);
  });

  it('defect 1: a same-batch bonificação before the transfer is in the carried average (TS-06)', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);
    // Step 1 — ORIGEM holds 100 @ 10,00, cost 1.000,00.
    expect(await positionAt(deps, ORIGEM)).toEqual({
      quantity: '100',
      averageCost: '10',
      totalCost: '1000',
    });

    await importFile(deps, [
      // Step 2 — bonificação of 100 at zero attributed value (BR-007-05):
      // 200 shares, cost still 1.000,00, average 5,00.
      buy({
        b3Type: 'Bonificação em Ativos',
        institutionName: ORIGEM,
        tradeDate: BusinessDate.of('2026-02-01'),
        priceStated: false,
        unitPrice: Money.zero(),
        fees: Money.zero(),
      }),
      // Step 3 — 100 leave ORIGEM for DESTINO on 2026-03-10.
      credit(),
      debit(),
    ]);

    // The credit carries 1.000,00 ÷ 200 = 5,00 — not the ledger-only 10,00.
    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('5');
    // DESTINO: 100 × 5,00 = 500,00.
    expect(await positionAt(deps, DESTINO)).toEqual({
      quantity: '100',
      averageCost: '5',
      totalCost: '500',
    });
    // ORIGEM: 200 − 100 leave at average cost → 100 @ 5,00 = 500,00.
    expect(await positionAt(deps, ORIGEM)).toEqual({
      quantity: '100',
      averageCost: '5',
      totalCost: '500',
    });

    // Re-import computes 5,00 again — and is a duplicate, so nothing moves.
    const again = await importFile(deps, [
      buy({
        b3Type: 'Bonificação em Ativos',
        institutionName: ORIGEM,
        tradeDate: BusinessDate.of('2026-02-01'),
        priceStated: false,
        unitPrice: Money.zero(),
        fees: Money.zero(),
      }),
      credit(),
      debit(),
    ]);
    expect(again.outcome).toMatchObject({ applied: 0, promoted: 0 });
    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('5');
    await expectRebuildEqualsIncremental(deps);
  });

  it('defect 6: a same-day buy at the source is in the carried average — (1.000,00 + 2.000,00) ÷ 200 = 15,00', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    await importFile(deps, [
      // Rank 1 on the transfer day: applied before the rank-3 debit.
      history({ tradeDate: TRANSFER_DAY, unitPrice: Money.fromString('20') }),
      credit(),
      debit(),
    ]);

    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('15');
    // ORIGEM: 200 @ 15,00 less 100 at average → 100 @ 15,00 = 1.500,00.
    expect(await positionAt(deps, ORIGEM)).toEqual({
      quantity: '100',
      averageCost: '15',
      totalCost: '1500',
    });
    await expectRebuildEqualsIncremental(deps);
  });

  it('defect 6: a debit with no institution is not a source', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history({ institutionName: null })]);

    await importFile(deps, [credit(), debit({ institutionName: null })]);

    expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
    expect(transfersIn(deps)[0]?.unitPrice.isZero()).toBe(true);
  });

  it.each([
    ['ORIGEM first', [ORIGEM, TERCEIRA]],
    ['TERCEIRA first', [TERCEIRA, ORIGEM]],
  ])(
    'defect 2: two candidate debits leave the credit unclassified (%s)',
    async (_label, sources) => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history(), history({ institutionName: TERCEIRA })]);

      const { batchId } = await importFile(deps, [
        credit(),
        ...sources.map((institutionName) => debit({ institutionName })),
      ]);

      expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
      const rows = await deps.rows.listByBatch(batchId);
      expect(rows.map((row) => row.classification)).toEqual(['unclassified', 'new', 'new']);
      expect(await positionAt(deps, DESTINO)).toBeUndefined();
    },
  );

  it('#117: a sale the transfer starves is refused alone, and the transfer still carries', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    // ORIGEM holds 100: the transfer of 100 on 10/03 and a sale of 100 on 12/03
    // cannot both happen. The replay stops at the sale, so only it is refused.
    const { batchId, outcome } = await importFile(deps, [
      credit(),
      debit(),
      buy({
        b3Type: 'Venda',
        institutionName: ORIGEM,
        tradeDate: BusinessDate.of('2026-03-12'),
      }),
    ]);

    expect(outcome.invalid).toBe(1);
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'active' });
    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
    expect(deps.transactions.rows.filter((t) => t.type === 'transfer_out')).toHaveLength(1);
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['new', 'new', 'invalid']);
    await expectRebuildEqualsIncremental(deps);
  });

  it('#117: a sale the destination cannot cover is refused alone, and the credit still carries', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    // DESTINO holds 100 carried; a sale of 150 there is the only row refused.
    const { batchId, outcome } = await importFile(deps, [
      credit(),
      debit(),
      buy({
        b3Type: 'Venda',
        institutionName: DESTINO,
        tradeDate: BusinessDate.of('2026-03-12'),
        quantity: Quantity.fromString('150'),
      }),
    ]);

    expect(outcome.invalid).toBe(1);
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'active' });
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['new', 'new', 'invalid']);
    expect(outcome.batch.rowCounts).toMatchObject({ new: 2, needsAttention: 1 });
    await expectRebuildEqualsIncremental(deps);
  });

  it('#117 review: a destination sale waits for its carry while the source refuses its own bad row', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    // ORIGEM's sale of 5 on 02/01 precedes its buy, so the source cannot
    // replay and the carry is unresolved in the first round. DESTINO's sale of
    // the 100 carried shares must not be refused for want of it.
    const { batchId, outcome } = await importFile(deps, [
      credit(),
      debit(),
      buy({
        b3Type: 'Venda',
        institutionName: ORIGEM,
        tradeDate: BusinessDate.of('2026-01-02'),
        quantity: Quantity.fromString('5'),
      }),
      buy({ b3Type: 'Venda', institutionName: DESTINO, tradeDate: BusinessDate.of('2026-03-12') }),
    ]);

    expect(outcome.invalid).toBe(1);
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['new', 'new', 'invalid', 'new']);
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'active' });
    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
    expect(await positionAt(deps, DESTINO)).toMatchObject({ quantity: '0' });
    await expectRebuildEqualsIncremental(deps);
  });

  describe('defect 3 — an unclassified copy already committed is promoted, whatever the import order', () => {
    it('the transfer first, the history later: promoted in place at 10,00, zero new transfers', async () => {
      const deps = buildFakeIngestionDeps();
      const first = await importFile(deps, [credit(), debit()]);
      // No history: the debit cannot leave ORIGEM (invalid), the credit waits.
      expect(first.outcome).toMatchObject({ applied: 1, invalid: 1 });
      const [waiting] = transfersIn(deps);
      expect(waiting).toMatchObject({ status: 'unclassified' });

      await importFile(deps, [history()]);
      const again = await importFile(deps, [credit(), debit()]);

      expect(again.outcome).toMatchObject({ applied: 1, promoted: 1 });
      expect(transfersIn(deps)).toHaveLength(1);
      const [promoted] = transfersIn(deps);
      expect(promoted).toMatchObject({
        id: waiting?.id,
        status: 'active',
        isUserModified: false,
        naturalKey: waiting?.naturalKey,
        occurrence: waiting?.occurrence,
      });
      expect(promoted?.unitPrice.toString()).toBe('10');
      expect(again.outcome.committed.map((t) => t.id)).toContain(waiting?.id);
      expect(await positionAt(deps, DESTINO)).toEqual({
        quantity: '100',
        averageCost: '10',
        totalCost: '1000',
      });
      // The row that first staged it leaves Needs attention.
      const origin = await deps.rows.listByBatch(first.batchId);
      expect(origin.find((row) => row.transactionId === waiting?.id)?.classification).toBe('new');

      // And a third import of the file changes nothing.
      const third = await importFile(deps, [credit(), debit()]);
      expect(third.outcome).toMatchObject({ applied: 0, promoted: 0 });
      await expectRebuildEqualsIncremental(deps);
    });

    it('the owner’s #108 state — debit active, credit unclassified — is promoted from the stored debit', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await commitAsIssue108(deps, [credit(), debit()]);
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });

      const again = await importFile(deps, [credit(), debit()]);

      expect(again.outcome).toMatchObject({ applied: 0, promoted: 1, skippedDuplicates: 2 });
      expect(deps.transactions.rows).toHaveLength(3);
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'active' });
      expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
      expect(await positionAt(deps, DESTINO)).toEqual({
        quantity: '100',
        averageCost: '10',
        totalCost: '1000',
      });
      await expectRebuildEqualsIncremental(deps);
    });

    it('never promotes a copy the user has edited (BR-006-16)', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await commitAsIssue108(deps, [credit(), debit()]);
      const [waiting] = transfersIn(deps);
      await deps.transactions.update({ ...(waiting as Transaction), isUserModified: true });

      const again = await importFile(deps, [credit(), debit()]);

      expect(again.outcome.promoted).toBe(0);
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
    });
  });

  it('defect 4: a fees-only edit of a carried transfer keeps its key, so a re-import is a duplicate', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);
    await importFile(deps, [credit(), debit()]);
    const [carried] = transfersIn(deps);
    if (carried === undefined) throw new Error('no carried transfer');

    // What `editTransactionAction` sends: every field, only the fees changed.
    const edited = await editTransaction(deps, carried.id, {
      assetId: carried.assetId,
      institutionId: carried.institutionId,
      type: carried.type,
      tradeDate: carried.tradeDate,
      quantity: carried.quantity,
      unitPrice: carried.unitPrice,
      fees: Money.fromString('1'),
    });
    expect(edited.ok && edited.value.transaction.naturalKey).toBe(carried.naturalKey);

    const again = await importFile(deps, [credit(), debit()]);

    expect(again.outcome).toMatchObject({ applied: 0, promoted: 0, skippedDuplicates: 2 });
    expect(transfersIn(deps)).toHaveLength(1);
    // 100 × 10,00 + 1,00 of fees = 1.001,00 at DESTINO, untouched by the re-import.
    expect(await positionAt(deps, DESTINO)).toEqual({
      quantity: '100',
      averageCost: '10.01',
      totalCost: '1001',
    });
  });

  it('review 1: several promotions into one position are applied together, and their origin batch counts move', async () => {
    const deps = buildFakeIngestionDeps();
    const B = 'Corretora B';
    const D = 'Corretora D';
    const file = [
      // 10/03: 100 ORIGEM→B and 50 TERCEIRA→B.
      credit({ institutionName: B }),
      debit(),
      credit({ institutionName: B, quantity: Quantity.fromString('50') }),
      debit({ institutionName: TERCEIRA, quantity: Quantity.fromString('50') }),
      // 12/03: all 150 B→D, which needs both credits into B.
      credit({
        institutionName: D,
        tradeDate: BusinessDate.of('2026-03-12'),
        quantity: Quantity.fromString('150'),
      }),
      debit({
        institutionName: B,
        tradeDate: BusinessDate.of('2026-03-12'),
        quantity: Quantity.fromString('150'),
      }),
    ];

    // No history: every debit is invalid, every credit waits.
    const first = await importFile(deps, file);
    expect(first.outcome).toMatchObject({ applied: 3, invalid: 3 });
    // #117: the refused debits are counted as needing attention, not as new.
    expect(first.outcome.batch.rowCounts).toMatchObject({ new: 0, needsAttention: 6 });

    // ORIGEM: 100 @ 10,00 = 1.000,00. TERCEIRA: 50 @ 16,00 = 800,00.
    await importFile(deps, [
      history(),
      history({
        institutionName: TERCEIRA,
        quantity: Quantity.fromString('50'),
        unitPrice: Money.fromString('16'),
      }),
    ]);

    const again = await importFile(deps, file);

    expect(again.outcome).toMatchObject({ applied: 3, promoted: 3, invalid: 0 });
    expect(transfersIn(deps).every((t) => t.status === 'active')).toBe(true);
    // B holds 100 @ 10,00 + 50 @ 16,00 = 1.800,00 over 150 before 12/03, so D
    // carries 1.800,00 ÷ 150 = 12,00 and B closes to zero.
    expect(await positionAt(deps, D)).toEqual({
      quantity: '150',
      averageCost: '12',
      totalCost: '1800',
    });
    expect(await positionAt(deps, B)).toMatchObject({ quantity: '0' });
    // BR-005-10: the first batch's stored counts follow its rows — the 3 promoted
    // credits are new, and the 3 debits it refused, now applied by the
    // re-import, are duplicates (#117).
    expect((await deps.batches.findById(first.batchId))?.rowCounts).toMatchObject({
      new: 3,
      duplicates: 3,
      needsAttention: 0,
    });
    await expectRebuildEqualsIncremental(deps);
  });

  describe('review 2 / #112 — a carried cost follows the source history on re-import', () => {
    const laterBuy = () =>
      history({ tradeDate: BusinessDate.of('2026-02-01'), unitPrice: Money.fromString('20') });

    it('the transfer before the buy: carried 10,00, corrected to 15,00 when the transfer file is re-imported', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await importFile(deps, [credit(), debit()]);
      const [before] = transfersIn(deps);
      expect(before?.unitPrice.toString()).toBe('10');

      // A buy of 100 @ 20,00 at ORIGEM on 01/02, imported afterwards.
      await importFile(deps, [laterBuy()]);
      const again = await importFile(deps, [credit(), debit()]);

      // ORIGEM before the 10/03 debit: 1.000,00 + 2.000,00 over 200 = 15,00.
      expect(again.outcome).toMatchObject({ applied: 0, promoted: 0, recarried: 1 });
      const [after] = transfersIn(deps);
      expect(after).toMatchObject({
        id: before?.id,
        naturalKey: before?.naturalKey,
        status: 'active',
        isUserModified: false,
      });
      expect(after?.unitPrice.toString()).toBe('15');
      expect(again.outcome.committed.map((t) => t.id)).toEqual([before?.id]);
      expect(await positionAt(deps, DESTINO)).toEqual({
        quantity: '100',
        averageCost: '15',
        totalCost: '1500',
      });

      // Unchanged the next time: nothing recomputes to a new figure.
      const third = await importFile(deps, [credit(), debit()]);
      expect(third.outcome).toMatchObject({ applied: 0, recarried: 0, committed: [] });
      await expectRebuildEqualsIncremental(deps);
    });

    it('the buy before the transfer reaches the same 15,00', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await importFile(deps, [laterBuy()]);
      await importFile(deps, [credit(), debit()]);

      expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('15');
    });

    it('review 4: a repeating average read back at the column scale is not rewritten on re-import', async () => {
      const deps = buildFakeIngestionDeps();
      // ORIGEM: 3 @ 10,00 + 1,00 fees = 31,00 → preço médio 10,333… (repeating).
      const three = { quantity: Quantity.fromString('3') };
      await importFile(deps, [history({ ...three, fees: Money.fromString('1') })]);
      await importFile(deps, [credit(three), debit(three)]);

      // NUMERIC(20,8) keeps 8 places; the fake does not, so store what Postgres would.
      const [carried] = transfersIn(deps) as Transaction[];
      expect(asStored((carried as Transaction).unitPrice)).toBe('10.33333333');
      const readBack = Money.fromString(asStored((carried as Transaction).unitPrice));
      await deps.transactions.update({
        ...(carried as Transaction),
        unitPrice: readBack,
        totalValue: computeTotalValue(
          'transfer_in',
          Quantity.fromString('3'),
          readBack,
          Money.zero(),
        ),
      });

      const again = await importFile(deps, [credit(three), debit(three)]);

      expect(again.outcome).toMatchObject({ recarried: 0, committed: [] });
    });

    it('never recomputes a carried transfer the user has edited (BR-006-16)', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await importFile(deps, [credit(), debit()]);
      const [carried] = transfersIn(deps);
      await editTransaction(deps, (carried as Transaction).id, { fees: Money.fromString('1') });

      await importFile(deps, [laterBuy()]);
      const again = await importFile(deps, [credit(), debit()]);

      expect(again.outcome.recarried).toBe(0);
      expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
    });
  });
});

describe('SPEC-005 BR-005-17..20 (#110) — rows an older map stored unclassified are fixed on re-import', () => {
  /** APLICAÇÃO of 100 PETR4 @ 32,15 with 4,90 of fees — map v3's `buy`, v2's unmapped. */
  const aplicacao = (overrides: Partial<NormalizedTransactionRecord> = {}) =>
    buy({ b3Type: 'APLICAÇÃO', direction: 'credit', ...overrides });
  const liquidacao = () => buy({ b3Type: 'Transferência - Liquidação', direction: 'credit' });
  /** Resgate of a CDB never bought — v3's `sell`, which cannot replay. */
  const resgate = () =>
    buy({ b3Type: 'Resgate', direction: 'credit', assetCode: 'CDB-X', assetName: 'CDB X' });

  async function importFile(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId });
    if (!result.ok) throw new Error(`commit failed: ${result.error.code}`);
    return { batchId, outcome: result.value };
  }

  /**
   * This morning's state: the file committed by a map that knew none of these
   * strings — every row an `unclassified` transaction under the placeholder
   * type and the raw B3 type (`importNaturalKeyFor`), every origin row
   * `unclassified` and counted as needing attention.
   */
  async function commitUnderMapV2(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const now = deps.clock.now();
    const staged = await deps.rows.listByBatch(batchId);
    const transactions: Transaction[] = [];
    const rows: ImportRow[] = [];
    for (const row of staged) {
      const record = row.record as NormalizedTransactionRecord;
      const naturalKey = importNaturalKeyFor(
        {
          assetId: row.assetId,
          institutionId: row.institutionId,
          type: UNCLASSIFIED_PLACEHOLDER_TYPE,
          tradeDate: record.tradeDate,
          quantity: record.quantity,
          unitPrice: record.unitPrice,
        },
        record.b3Type,
      );
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
        naturalKey,
        occurrence: 1,
        importBatchId: batchId,
        isManual: false,
        isUserModified: false,
        createdAt: now,
        updatedAt: now,
      };
      transactions.push(transaction);
      rows.push({
        ...row,
        classification: 'unclassified',
        naturalKey,
        occurrence: 1,
        ledgerType: UNCLASSIFIED_PLACEHOLDER_TYPE,
        transactionId: transaction.id,
      });
    }
    await deps.transactions.insertMany(transactions);
    await deps.rows.insertMany(rows); // replaces the staged rows by id
    const batch = (await deps.batches.findById(batchId)) as ImportBatch;
    await deps.batches.update({
      ...batch,
      status: 'committed',
      rowCounts: {
        read: staged.length,
        new: 0,
        duplicates: 0,
        needsAttention: staged.length,
        ignored: 0,
        fromDate: null,
        toDate: null,
      },
    });
    return { batchId, transactions };
  }

  const rowFor = async (deps: FakeIngestionDeps, batchId: ImportBatchId, id: TransactionId) =>
    (await deps.rows.listByBatch(batchId)).find((row) => row.transactionId === id);

  it('a row that now mirrors another extract is superseded, and its origin row and counts become ignored', async () => {
    const deps = buildFakeIngestionDeps();
    const { batchId, transactions } = await commitUnderMapV2(deps, [liquidacao()]);
    const [stored] = transactions as [Transaction];

    const again = await importFile(deps, [liquidacao()]);

    expect(again.outcome).toMatchObject({
      applied: 0,
      superseded: 1,
      reclassified: 0,
      skippedDuplicates: 1,
      committed: [],
    });
    expect(await deps.transactions.findById(stored.id)).toMatchObject({
      status: 'superseded',
      naturalKey: stored.naturalKey,
      isUserModified: false,
    });
    expect((await rowFor(deps, batchId, stored.id))?.classification).toBe('ignored');
    // 1 needing attention − 1 = 0; 0 ignored + 1 = 1.
    expect((await deps.batches.findById(batchId))?.rowCounts).toMatchObject({
      new: 0,
      needsAttention: 0,
      ignored: 1,
    });
    // The re-import's own row stays a duplicate, and no position was written.
    const current = await deps.rows.listByBatch(again.batchId);
    expect(current.map((row) => row.classification)).toEqual(['duplicate']);
    expect(await deps.positions.list()).toHaveLength(0);
  });

  it('an APLICAÇÃO is activated in place as a buy and the position recalculated', async () => {
    const deps = buildFakeIngestionDeps();
    const { batchId, transactions } = await commitUnderMapV2(deps, [aplicacao()]);
    const [stored] = transactions as [Transaction];

    const again = await importFile(deps, [aplicacao()]);

    expect(again.outcome).toMatchObject({ applied: 0, reclassified: 1, superseded: 0 });
    expect(again.outcome.committed.map((t) => t.id)).toEqual([stored.id]);
    expect(await deps.transactions.findById(stored.id)).toMatchObject({
      type: 'buy',
      status: 'active',
      naturalKey: stored.naturalKey,
      isUserModified: false,
    });
    // 100 × 32,15 + 4,90 = 3.219,90 over 100 → 32,199.
    const [position] = await deps.positions.list();
    expect(position?.state.quantity.toString()).toBe('100');
    expect(position?.state.totalCost.toString()).toBe('3219.9');
    expect(position?.state.averageCost.toString()).toBe('32.199');
    expect((await rowFor(deps, batchId, stored.id))?.classification).toBe('new');
    expect((await deps.batches.findById(batchId))?.rowCounts).toMatchObject({
      new: 1,
      needsAttention: 0,
    });
    expect(deps.transactions.rows).toHaveLength(1);
  });

  it('a Resgate that cannot replay as a sell stays unclassified, and the rest of the commit applies', async () => {
    const deps = buildFakeIngestionDeps();
    const { batchId, transactions } = await commitUnderMapV2(deps, [resgate(), aplicacao()]);
    const [storedResgate, storedAplicacao] = transactions as [Transaction, Transaction];

    const again = await importFile(deps, [resgate(), aplicacao()]);

    expect(again.outcome).toMatchObject({ reclassified: 1, superseded: 0 });
    expect(await deps.transactions.findById(storedResgate.id)).toMatchObject({
      type: UNCLASSIFIED_PLACEHOLDER_TYPE,
      status: 'unclassified',
    });
    expect(await deps.transactions.findById(storedAplicacao.id)).toMatchObject({
      type: 'buy',
      status: 'active',
    });
    expect((await rowFor(deps, batchId, storedResgate.id))?.classification).toBe('unclassified');
    // 2 needing attention − 1 activated = 1.
    expect((await deps.batches.findById(batchId))?.rowCounts).toMatchObject({
      new: 1,
      needsAttention: 1,
    });
  });

  it('never touches a copy the user edited (BR-006-16)', async () => {
    const deps = buildFakeIngestionDeps();
    const { transactions } = await commitUnderMapV2(deps, [aplicacao()]);
    const [stored] = transactions as [Transaction];
    await deps.transactions.update({ ...stored, isUserModified: true });

    const again = await importFile(deps, [aplicacao()]);

    expect(again.outcome.reclassified).toBe(0);
    expect(await deps.transactions.findById(stored.id)).toMatchObject({ status: 'unclassified' });
  });

  it('never touches a copy the user classified by hand (BR-005-20)', async () => {
    const deps = buildFakeIngestionDeps();
    const { batchId, transactions } = await commitUnderMapV2(deps, [aplicacao()]);
    const [stored] = transactions as [Transaction];
    const origin = await rowFor(deps, batchId, stored.id);
    const classified = await classifyImportRow(deps, {
      rowId: (origin as ImportRow).id,
      type: 'subscription',
    });
    expect(classified.ok).toBe(true);

    const again = await importFile(deps, [aplicacao()]);

    expect(again.outcome).toMatchObject({ applied: 0, reclassified: 0, superseded: 0 });
    expect(await deps.transactions.findById(stored.id)).toMatchObject({ type: 'subscription' });
    expect(deps.transactions.rows).toHaveLength(1);
  });

  it('never touches a manual transaction', async () => {
    const deps = buildFakeIngestionDeps();
    const { transactions } = await commitUnderMapV2(deps, [aplicacao()]);
    const [stored] = transactions as [Transaction];
    await deps.transactions.update({ ...stored, importBatchId: null, isManual: true });

    const again = await importFile(deps, [aplicacao()]);

    expect(again.outcome.reclassified).toBe(0);
    expect(await deps.transactions.findById(stored.id)).toMatchObject({ status: 'unclassified' });
  });

  it('a second re-import of the same file changes nothing', async () => {
    const deps = buildFakeIngestionDeps();
    await commitUnderMapV2(deps, [liquidacao(), aplicacao()]);
    await importFile(deps, [liquidacao(), aplicacao()]);
    const updates = deps.transactions.updateCount;
    const upserts = deps.positions.upsertCount;

    const third = await importFile(deps, [liquidacao(), aplicacao()]);

    expect(third.outcome).toMatchObject({
      applied: 0,
      reclassified: 0,
      superseded: 0,
      committed: [],
    });
    expect(deps.transactions.updateCount).toBe(updates);
    expect(deps.positions.upsertCount).toBe(upserts);
  });

  it('AR-19: committing the re-import batch twice applies it once', async () => {
    const deps = buildFakeIngestionDeps();
    await commitUnderMapV2(deps, [liquidacao(), aplicacao()]);
    const { batchId } = await importFile(deps, [liquidacao(), aplicacao()]);
    const updates = deps.transactions.updateCount;

    const retried = await commitBatch(deps, userId, { batchId });

    expect(retried.ok && retried.value).toMatchObject({
      reclassified: 0,
      superseded: 0,
      committed: [],
    });
    expect(deps.transactions.updateCount).toBe(updates);
  });
});

describe('SPEC-005 #117 — a failing position refuses only the rows it cannot replay', () => {
  const HGLG = { assetCode: 'HGLG11', assetName: 'CSHG Logística', assetClass: 'fii' as const };
  const rendimento = (date: string) =>
    buy({
      ...HGLG,
      b3Type: 'Rendimento',
      direction: 'credit',
      tradeDate: BusinessDate.of(date),
      quantity: Quantity.fromString('10'),
      unitPrice: Money.fromString('1.10'),
      fees: Money.zero(),
    });
  const transferOut = (date: string, quantity = '10') =>
    buy({
      ...HGLG,
      b3Type: 'Transferência',
      direction: 'debit',
      tradeDate: BusinessDate.of(date),
      quantity: Quantity.fromString(quantity),
      priceStated: false,
      unitPrice: Money.zero(),
      fees: Money.zero(),
    });
  /** 10 HGLG11 at 160,00 → cost 1.600,00. */
  const holding = () =>
    buy({
      ...HGLG,
      tradeDate: BusinessDate.of('2026-01-05'),
      quantity: Quantity.fromString('10'),
      unitPrice: Money.fromString('160'),
      fees: Money.zero(),
    });

  async function importFile(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId });
    if (!result.ok) throw new Error(`commit failed: ${result.error.code}`);
    return { batchId, outcome: result.value };
  }

  const ledgerTypes = (deps: FakeIngestionDeps) => deps.transactions.rows.map((t) => t.type).sort();

  it('one transfer debit with no holding behind it no longer discards the asset’s proventos', async () => {
    const deps = buildFakeIngestionDeps();

    const { batchId, outcome } = await importFile(deps, [
      rendimento('2026-01-15'),
      rendimento('2026-02-13'),
      transferOut('2026-02-20'),
    ]);

    expect(outcome).toMatchObject({ applied: 2, invalid: 1 });
    expect(ledgerTypes(deps)).toEqual(['rendimento', 'rendimento']);
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['new', 'new', 'invalid']);
    // BR-005-10: the committed counts say what the preview could not know.
    expect(outcome.batch.rowCounts).toMatchObject({ new: 2, needsAttention: 1 });
  });

  it('refuses every unreplayable row of one position in a single commit, and keeps the rest', async () => {
    const deps = buildFakeIngestionDeps();

    const { outcome } = await importFile(deps, [
      transferOut('2026-02-01', '5'),
      transferOut('2026-02-10', '5'),
      rendimento('2026-02-13'),
    ]);

    expect(outcome).toMatchObject({ applied: 1, invalid: 2 });
    expect(ledgerTypes(deps)).toEqual(['rendimento']);
  });

  it('a stored sale a staged transfer would starve refuses the transfer, and keeps the provento', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [
      holding(),
      buy({
        ...HGLG,
        b3Type: 'Venda',
        tradeDate: BusinessDate.of('2026-03-12'),
        quantity: Quantity.fromString('10'),
        unitPrice: Money.fromString('170'),
      }),
    ]);

    // 10 held; 5 leave on 10/03, so the stored sale of 10 on 12/03 fails — at
    // a row this batch did not stage.
    const { batchId, outcome } = await importFile(deps, [
      transferOut('2026-03-10', '5'),
      rendimento('2026-03-11'),
    ]);

    expect(outcome).toMatchObject({ applied: 1, invalid: 1 });
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['invalid', 'new']);
    expect(ledgerTypes(deps)).toEqual(['buy', 'rendimento', 'sell']);
  });

  it('BR-005-17: once the history is in, re-importing applies the refused row once and the earlier copy leaves Needs attention', async () => {
    const deps = buildFakeIngestionDeps();
    const file = [rendimento('2026-02-13'), transferOut('2026-02-20')];
    const first = await importFile(deps, file);
    expect(first.outcome).toMatchObject({ applied: 1, invalid: 1 });

    await importFile(deps, [holding()]);
    const again = await importFile(deps, file);

    expect(again.outcome).toMatchObject({ applied: 1, skippedDuplicates: 1, invalid: 0 });
    expect(ledgerTypes(deps)).toEqual(['buy', 'rendimento', 'transfer_out']);
    const earlier = await deps.rows.listByBatch(first.batchId);
    expect(earlier.map((row) => row.classification)).toEqual(['new', 'duplicate']);
    expect((await deps.batches.findById(first.batchId))?.rowCounts).toMatchObject({
      new: 1,
      duplicates: 1,
      needsAttention: 0,
    });
    const [position] = await deps.positions.list();
    expect(position?.state.quantity.toString()).toBe('0');

    const third = await importFile(deps, file);
    expect(third.outcome).toMatchObject({ applied: 0, skippedDuplicates: 2, invalid: 0 });
    expect(deps.transactions.rows).toHaveLength(3);
  });

  it('BR-005-17: proventos a pre-#117 commit refused with their whole position apply on re-import, once', async () => {
    const deps = buildFakeIngestionDeps();
    const file = [rendimento('2026-01-15'), rendimento('2026-02-13'), transferOut('2026-02-20')];
    // The owner's state: every row of the position stored `invalid`, counted new.
    const legacy = await stagedBatch(deps, { extractType: 'b3_movimentacao', records: file });
    for (const row of await deps.rows.listByBatch(legacy)) {
      await deps.rows.updateClassification(row.id, 'invalid');
    }
    const staged = (await deps.batches.findById(legacy)) as ImportBatch;
    await deps.batches.update({ ...staged, status: 'committed' });

    const again = await importFile(deps, file);

    expect(again.outcome).toMatchObject({ applied: 2, invalid: 1 });
    expect(ledgerTypes(deps)).toEqual(['rendimento', 'rendimento']);
    const earlier = await deps.rows.listByBatch(legacy);
    expect(earlier.map((row) => row.classification)).toEqual(['duplicate', 'duplicate', 'invalid']);
    expect((await deps.batches.findById(legacy))?.rowCounts).toMatchObject({
      new: 0,
      duplicates: 2,
      needsAttention: 1,
    });

    const third = await importFile(deps, file);
    expect(third.outcome).toMatchObject({ applied: 0, skippedDuplicates: 2, invalid: 1 });
    expect(deps.transactions.rows).toHaveLength(2);
  });

  const sale = (date: string, quantity: string) =>
    buy({
      ...HGLG,
      b3Type: 'Venda',
      tradeDate: BusinessDate.of(date),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString('170'),
      fees: Money.zero(),
    });

  it('#117 review: a stored sale a staged transfer starves refuses only that transfer, and a later valid sale still applies — on every import', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [holding(), sale('2026-02-20', '10')]);

    // 10 held; 5 leave on 10/02, so the stored sale of 10 on 20/02 fails. The
    // buy of 5 and sale of 5 in March replay on their own: 0 + 5 − 5.
    const file = [
      transferOut('2026-02-10', '5'),
      buy({
        ...HGLG,
        tradeDate: BusinessDate.of('2026-03-01'),
        quantity: Quantity.fromString('5'),
        unitPrice: Money.fromString('150'),
        fees: Money.zero(),
      }),
      sale('2026-03-05', '5'),
      rendimento('2026-03-10'),
    ];
    const { batchId, outcome } = await importFile(deps, file);

    expect(outcome).toMatchObject({ applied: 3, invalid: 1 });
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['invalid', 'new', 'new', 'new']);

    const again = await importFile(deps, file);
    expect(again.outcome).toMatchObject({ applied: 0, skippedDuplicates: 3, invalid: 1 });
  });

  it('a stored ledger that fails on its own refuses the whole position, as before', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [holding(), sale('2026-02-20', '10')]);
    // Only reachable by editing around the write path: the buy leaves the replay.
    const storedBuy = deps.transactions.rows.find((t) => t.type === 'buy') as Transaction;
    await deps.transactions.update({ ...storedBuy, status: 'superseded' });

    const { outcome } = await importFile(deps, [rendimento('2026-03-10')]);

    expect(outcome).toMatchObject({ applied: 0, invalid: 1 });
  });
});

describe('SPEC-005 BR-005-20b (#113) — corporate-event rows resolve at commit', () => {
  /** A Movimentação row, fees zero so every figure below is the price arithmetic alone. */
  function movement(
    b3Type: string,
    direction: 'credit' | 'debit' | null,
    assetCode: string,
    date: string,
    quantity: string,
    price = '0',
  ): ParsedRecord {
    return buy({
      b3Type,
      direction,
      assetCode,
      assetName: assetCode,
      tradeDate: BusinessDate.of(date),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString(price),
      priceStated: price !== '0',
      fees: Money.zero(),
    });
  }
  const compra = (code: string, date: string, qty: string, price: string) =>
    movement('Compra', 'credit', code, date, qty, price);
  const venda = (code: string, date: string, qty: string, price: string) =>
    movement('Venda', 'debit', code, date, qty, price);
  const desdobro = (code: string, date: string, qty: string) =>
    movement('Desdobro', 'credit', code, date, qty);
  const grupamento = (code: string, date: string, qty: string) =>
    movement('Grupamento', 'credit', code, date, qty);
  const bonificacao = (code: string, date: string, qty: string) =>
    movement('Bonificação em Ativos', 'credit', code, date, qty);
  const fracao = (code: string, date: string, qty: string) =>
    movement('Fração em Ativos', 'debit', code, date, qty);
  const leilao = (code: string, date: string, qty: string, price: string) =>
    movement('Leilão de Fração', 'credit', code, date, qty, price);

  function factor(
    issuerCode: string,
    kind: CorporateEventFactorKind,
    published: string,
    lastDatePrior: string,
  ): CorporateEventFactor {
    return {
      issuerCode,
      kind,
      factorPublished: published,
      multiplier: factorMultiplier(kind, published),
      lastDatePrior: BusinessDate.of(lastDatePrior),
      approvedOn: null,
    };
  }

  async function importFile(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId });
    if (!result.ok) throw new Error(`commit failed: ${result.error.code}`);
    return { batchId, outcome: result.value };
  }

  async function rowOf(deps: FakeIngestionDeps, batchId: ImportBatchId, b3Type: string) {
    const row = (await deps.rows.listByBatch(batchId)).find(
      (r) => r.record.kind === 'transaction' && r.record.b3Type === b3Type,
    );
    if (row === undefined) throw new Error(`no ${b3Type} row`);
    return row;
  }

  async function transactionOf(deps: FakeIngestionDeps, batchId: ImportBatchId, b3Type: string) {
    const row = await rowOf(deps, batchId, b3Type);
    const transaction =
      row.transactionId === null ? null : await deps.transactions.findById(row.transactionId);
    if (transaction === null) throw new Error(`no transaction for ${b3Type}`);
    return transaction;
  }

  async function positionOf(deps: FakeIngestionDeps, code: string) {
    const assetId = await deps.assets.resolve({
      code,
      name: code,
      assetClass: 'stock',
      classStated: false,
      nameStated: true,
    });
    return (await deps.positions.list()).find((p) => p.assetId === assetId)?.state;
  }

  /** ALZR11: 70 @ 100,00 then a Desdobro of +630 (factor 900 → ×10). */
  const alzr = () => [
    compra('ALZR11', '2024-01-10', '70', '100'),
    desdobro('ALZR11', '2024-03-05', '630'),
  ];
  const alzrFactor = () => factor('ALZR', 'desdobramento', '900', '2024-03-01');
  /** GRND3: 105 @ 10,00, Grupamento → 10,5 (factor 0.1), Fração 0,5, Leilão 0,5 @ 98,00. */
  const grnd = () => [
    compra('GRND3', '2024-05-01', '105', '10'),
    grupamento('GRND3', '2024-05-28', '10.5'),
    fracao('GRND3', '2024-05-30', '0.5'),
    leilao('GRND3', '2024-06-10', '0.5', '98'),
  ];
  const grndFactor = () => factor('GRND', 'grupamento', '0.1', '2024-05-24');

  it('first import: 70 shares and a Desdobro of 630 with factor 900 apply as a split ×10 — 700 at 10,00', async () => {
    // m = 1 + 900 ÷ 100 = 10; 70 × (10 − 1) = 630 = Δ. Cost 70 × 100,00 = 7.000,00;
    // after ×10, 700 shares at 7.000 ÷ 700 = 10,00.
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(alzrFactor());

    const { batchId, outcome } = await importFile(deps, alzr());

    expect(outcome).toMatchObject({ applied: 2, resolvedCorporateEvents: 1, consumedAuctions: 0 });
    const row = await rowOf(deps, batchId, 'Desdobro');
    expect(row.classification).toBe('new');
    const split = await transactionOf(deps, batchId, 'Desdobro');
    expect(split).toMatchObject({
      type: 'split',
      status: 'active',
      naturalKey: row.naturalKey,
      occurrence: row.occurrence,
      isUserModified: false,
    });
    expect(split.ratio?.toString()).toBe('10');
    expect(outcome.committed.map((t) => t.id)).toContain(split.id);
    const position = await positionOf(deps, 'ALZR11');
    expect(position?.quantity.toString()).toBe('700');
    expect(position?.totalCost.toString()).toBe('7000');
    expect(position?.averageCost.toString()).toBe('10');
    expect(deps.corporateEventFactors.calls).toEqual([['ALZR']]);
  });

  it('a bonificação fraction becomes fracao_bonificacao and its auction a 2,50 leilao_fracoes', async () => {
    // 100 @ 20,00 = 2.000,00; bonificação 5,2 → 105,2 (fractional part 0,2);
    // Fração 0,2 removed at unchanged cost → 105 shares, 2.000,00, average
    // 19,047619…; Leilão 0,2 × 12,50 = 2,50 of income.
    const deps = buildFakeIngestionDeps();
    const { batchId, outcome } = await importFile(deps, [
      compra('ITSA4', '2025-11-03', '100', '20'),
      bonificacao('ITSA4', '2025-12-10', '5.2'),
      fracao('ITSA4', '2025-12-15', '0.2'),
      leilao('ITSA4', '2026-01-20', '0.2', '12.50'),
    ]);

    expect(outcome).toMatchObject({ resolvedCorporateEvents: 2, consumedAuctions: 0 });
    const removal = await transactionOf(deps, batchId, 'Fração em Ativos');
    expect(removal).toMatchObject({ type: 'fracao_bonificacao', status: 'active' });
    expect(removal.totalValue.isZero()).toBe(true);
    const income = await transactionOf(deps, batchId, 'Leilão de Fração');
    expect(income).toMatchObject({ type: 'leilao_fracoes', status: 'active' });
    expect(income.totalValue.toString()).toBe('2.5');
    const position = await positionOf(deps, 'ITSA4');
    expect(position?.quantity.toString()).toBe('105');
    expect(position?.totalCost.toString()).toBe('2000');
    expect(position?.realizedGain.isZero()).toBe(true);
    expect(asStored(position?.averageCost as Money)).toBe('19.04761905');
    // No ratio row: the factor store is never asked.
    expect(deps.corporateEventFactors.calls).toEqual([]);
  });

  it('a grupamento fraction is sold at 98,00 realising −1,00, its auction superseded and ignored; the same file again writes nothing', async () => {
    // 105 @ 10,00 = 1.050,00; ×0,1 → 10,5 at 100,00; sell 0,5 @ 98,00:
    // 49,00 − 0,5 × 100,00 = −1,00; 10 shares, 1.000,00 left.
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(grndFactor());
    const { batchId, outcome } = await importFile(deps, grnd());

    expect(outcome).toMatchObject({ applied: 3, resolvedCorporateEvents: 2, consumedAuctions: 1 });
    expect((await transactionOf(deps, batchId, 'Grupamento')).ratio?.toString()).toBe('0.1');
    const sale = await transactionOf(deps, batchId, 'Fração em Ativos');
    expect(sale).toMatchObject({ type: 'sell', status: 'active', tradeDate: '2024-05-30' });
    expect(sale.unitPrice.toString()).toBe('98');
    expect(sale.totalValue.toString()).toBe('49');
    const auction = await transactionOf(deps, batchId, 'Leilão de Fração');
    expect(auction.status).toBe('superseded');
    expect((await rowOf(deps, batchId, 'Leilão de Fração')).classification).toBe('ignored');
    expect(outcome.committed.map((t) => t.id)).not.toContain(auction.id);
    expect(outcome.batch.rowCounts).toMatchObject({ new: 3, ignored: 1, needsAttention: 0 });
    const position = await positionOf(deps, 'GRND3');
    expect(position?.quantity.toString()).toBe('10');
    expect(position?.totalCost.toString()).toBe('1000');
    expect(position?.realizedGain.toString()).toBe('-1');

    const writes = [
      deps.transactions.insertCount,
      deps.transactions.updateCount,
      deps.positions.upsertCount,
    ];
    const again = await importFile(deps, grnd());
    expect(again.outcome).toMatchObject({
      applied: 0,
      skippedDuplicates: 4,
      resolvedCorporateEvents: 0,
      consumedAuctions: 0,
      committed: [],
    });
    expect([
      deps.transactions.insertCount,
      deps.transactions.updateCount,
      deps.positions.upsertCount,
    ]).toEqual(writes);
  });

  it('with no factors (reader outage) the ratio rows stay unclassified and the commit succeeds', async () => {
    const deps = buildFakeIngestionDeps();
    const { batchId, outcome } = await importFile(deps, [...alzr(), ...grnd()]);

    expect(outcome).toMatchObject({ resolvedCorporateEvents: 0, consumedAuctions: 0 });
    for (const b3Type of ['Desdobro', 'Grupamento', 'Fração em Ativos', 'Leilão de Fração']) {
      expect((await transactionOf(deps, batchId, b3Type)).status).toBe('unclassified');
      expect((await rowOf(deps, batchId, b3Type)).classification).toBe('unclassified');
    }
    // Only the two buys moved a position: 70 and 105.
    expect((await positionOf(deps, 'ALZR11'))?.quantity.toString()).toBe('70');
    expect((await positionOf(deps, 'GRND3'))?.quantity.toString()).toBe('105');
  });

  it('re-import: all four types stored unclassified are resolved in place, key kept, not user-modified; a second re-import writes nothing', async () => {
    const deps = buildFakeIngestionDeps();
    const file = [...alzr(), ...grnd()];
    // Committed before the factors were known: four rows need attention.
    const first = await importFile(deps, file);
    expect(first.outcome.batch.rowCounts).toMatchObject({ new: 2, needsAttention: 4, ignored: 0 });
    const before = {
      desdobro: await transactionOf(deps, first.batchId, 'Desdobro'),
      grupamento: await transactionOf(deps, first.batchId, 'Grupamento'),
      fracao: await transactionOf(deps, first.batchId, 'Fração em Ativos'),
      leilao: await transactionOf(deps, first.batchId, 'Leilão de Fração'),
    };

    deps.corporateEventFactors.seed(alzrFactor(), grndFactor());
    const again = await importFile(deps, file);

    expect(again.outcome).toMatchObject({
      applied: 0,
      reclassified: 0,
      superseded: 0,
      resolvedCorporateEvents: 3,
      consumedAuctions: 1,
    });
    expect(again.outcome.committed.map((t) => t.id).sort()).toEqual(
      [before.desdobro.id, before.grupamento.id, before.fracao.id].sort(),
    );
    expect(await deps.transactions.findById(before.desdobro.id)).toMatchObject({
      type: 'split',
      status: 'active',
      naturalKey: before.desdobro.naturalKey,
      isUserModified: false,
    });
    expect(await deps.transactions.findById(before.grupamento.id)).toMatchObject({
      type: 'grupamento',
      status: 'active',
      naturalKey: before.grupamento.naturalKey,
      isUserModified: false,
    });
    const sale = await deps.transactions.findById(before.fracao.id);
    expect(sale).toMatchObject({
      type: 'sell',
      status: 'active',
      naturalKey: before.fracao.naturalKey,
      isUserModified: false,
    });
    // 0,5 × 98,00 = 49,00, recomputed with the price.
    expect(sale?.unitPrice.toString()).toBe('98');
    expect(sale?.totalValue.toString()).toBe('49');
    expect(await deps.transactions.findById(before.leilao.id)).toMatchObject({
      status: 'superseded',
      naturalKey: before.leilao.naturalKey,
      isUserModified: false,
    });
    // The origin rows leave Needs attention: 3 → new, 1 → ignored; 4 − 4 = 0.
    expect((await rowOf(deps, first.batchId, 'Desdobro')).classification).toBe('new');
    expect((await rowOf(deps, first.batchId, 'Leilão de Fração')).classification).toBe('ignored');
    expect((await deps.batches.findById(first.batchId))?.rowCounts).toMatchObject({
      new: 5,
      ignored: 1,
      needsAttention: 0,
    });
    expect(deps.transactions.rows).toHaveLength(6);
    // 700 at 10,00; 10 at 100,00 with −1,00 realised.
    expect((await positionOf(deps, 'ALZR11'))?.quantity.toString()).toBe('700');
    const grndPosition = await positionOf(deps, 'GRND3');
    expect(grndPosition?.quantity.toString()).toBe('10');
    expect(grndPosition?.realizedGain.toString()).toBe('-1');

    const writes = [
      deps.transactions.insertCount,
      deps.transactions.updateCount,
      deps.positions.upsertCount,
    ];
    const third = await importFile(deps, file);
    expect(third.outcome).toMatchObject({
      applied: 0,
      resolvedCorporateEvents: 0,
      consumedAuctions: 0,
      committed: [],
    });
    expect([
      deps.transactions.insertCount,
      deps.transactions.updateCount,
      deps.positions.upsertCount,
    ]).toEqual(writes);
  });

  it('a Desdobro’s P includes shares carried in by a same-file transfer (BR-005-20a before BR-005-20b)', async () => {
    // Origem: 70 @ 100,00. Transfer of 70 to Destino carries 7.000 ÷ 70 = 100,00.
    // At Destino P = 70; 70 × 9 = 630 = Δ → 700 shares at 10,00.
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(alzrFactor());
    const at = (record: ParsedRecord, institutionName: string): ParsedRecord => ({
      ...record,
      record: { ...(record.record as NormalizedTransactionRecord), institutionName },
    });
    const { outcome } = await importFile(deps, [
      at(compra('ALZR11', '2024-01-10', '70', '100'), 'Corretora Origem'),
      at(movement('Transferência', 'debit', 'ALZR11', '2024-02-01', '70'), 'Corretora Origem'),
      at(movement('Transferência', 'credit', 'ALZR11', '2024-02-01', '70'), 'Corretora Destino'),
      at(desdobro('ALZR11', '2024-03-05', '630'), 'Corretora Destino'),
    ]);

    expect(outcome).toMatchObject({ resolvedCorporateEvents: 1 });
    const destino = await deps.institutions.resolve('Corretora Destino');
    const position = (await deps.positions.list()).find((p) => p.institutionId === destino);
    expect(position?.state.quantity.toString()).toBe('700');
    expect(position?.state.totalCost.toString()).toBe('7000');
    expect(position?.state.averageCost.toString()).toBe('10');
  });

  it('asks the factor store only for issuers it can name, and a ticker with none stays unclassified', async () => {
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(alzrFactor());
    const { batchId } = await importFile(deps, [
      ...alzr(),
      compra('AXIA15G', '2024-01-10', '80', '10'),
      desdobro('AXIA15G', '2024-03-05', '80'),
    ]);

    expect(deps.corporateEventFactors.calls).toEqual([['ALZR']]);
    const rows = await deps.rows.listByBatch(batchId);
    const axia = rows.find(
      (r) =>
        r.record.kind === 'transaction' &&
        r.record.assetCode === 'AXIA15G' &&
        r.record.b3Type === 'Desdobro',
    );
    expect(axia?.classification).toBe('unclassified');
  });

  it('a future-dated Desdobro is refused as invalid, as any malformed row is', async () => {
    // Today is 2026-03-15.
    const deps = buildFakeIngestionDeps();
    const { batchId, outcome } = await importFile(deps, [
      compra('ALZR11', '2024-01-10', '70', '100'),
      desdobro('ALZR11', '2026-04-01', '630'),
    ]);

    expect(outcome).toMatchObject({ invalid: 1, resolvedCorporateEvents: 0 });
    expect((await rowOf(deps, batchId, 'Desdobro')).classification).toBe('invalid');
  });

  it('never resolves against an auction left unclassified by another file: both stay unclassified', async () => {
    // File 1 carries the Leilão alone (no fraction to pair). File 2 carries the
    // Fração: its only partner is stored unclassified and not in this import.
    const deps = buildFakeIngestionDeps();
    const history = [
      compra('ITSA4', '2025-11-03', '100', '20'),
      bonificacao('ITSA4', '2025-12-10', '5.2'),
    ];
    const first = await importFile(deps, [
      ...history,
      leilao('ITSA4', '2026-01-20', '0.2', '12.50'),
    ]);
    const second = await importFile(deps, [...history, fracao('ITSA4', '2025-12-15', '0.2')]);

    expect(second.outcome).toMatchObject({ resolvedCorporateEvents: 0, consumedAuctions: 0 });
    expect((await transactionOf(deps, first.batchId, 'Leilão de Fração')).status).toBe(
      'unclassified',
    );
    expect((await transactionOf(deps, second.batchId, 'Fração em Ativos')).status).toBe(
      'unclassified',
    );
  });

  it('a grupamento that disagrees with the published factor stays unclassified', async () => {
    // 80 × 0,1 = 8 ≠ 40.
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(factor('MGLU', 'grupamento', '0.1', '2024-05-24'));
    const { batchId, outcome } = await importFile(deps, [
      compra('MGLU3', '2024-01-02', '80', '10'),
      grupamento('MGLU3', '2024-05-28', '40'),
    ]);

    expect(outcome.resolvedCorporateEvents).toBe(0);
    expect(await transactionOf(deps, batchId, 'Grupamento')).toMatchObject({
      type: UNCLASSIFIED_PLACEHOLDER_TYPE,
      status: 'unclassified',
    });
    expect((await rowOf(deps, batchId, 'Grupamento')).classification).toBe('unclassified');
    expect((await positionOf(deps, 'MGLU3'))?.quantity.toString()).toBe('80');
  });

  it('never touches a Desdobro the user classified by hand', async () => {
    const deps = buildFakeIngestionDeps();
    const first = await importFile(deps, alzr());
    const row = await rowOf(deps, first.batchId, 'Desdobro');
    const classified = await classifyImportRow(deps, {
      rowId: row.id,
      type: 'split',
      ratio: Quantity.fromString('10'),
    });
    expect(classified.ok).toBe(true);
    const stored = await transactionOf(deps, first.batchId, 'Desdobro');
    const updates = deps.transactions.updateCount;

    deps.corporateEventFactors.seed(alzrFactor());
    const again = await importFile(deps, alzr());

    expect(again.outcome).toMatchObject({ resolvedCorporateEvents: 0, applied: 0 });
    expect(await deps.transactions.findById(stored.id)).toEqual(stored);
    expect(deps.transactions.updateCount).toBe(updates);
  });

  it('declines a resolved grupamento that would starve a later stored sale; the rest of the commit applies', async () => {
    // SIMH3: 220 bought, 200 sold after the grupamento date. ×0,5 would leave
    // 110 < 200, so the grupamento is given up and stays unclassified. The new
    // dividend on the same position and ALZR11's desdobro still apply.
    const deps = buildFakeIngestionDeps();
    const simh = [
      compra('SIMH3', '2024-01-02', '220', '11'),
      grupamento('SIMH3', '2024-08-12', '110'),
      venda('SIMH3', '2024-09-02', '200', '15'),
    ];
    const first = await importFile(deps, simh);
    expect((await positionOf(deps, 'SIMH3'))?.quantity.toString()).toBe('20');

    deps.corporateEventFactors.seed(
      factor('SIMH', 'grupamento', '0.5', '2024-08-09'),
      alzrFactor(),
    );
    const again = await importFile(deps, [
      ...simh,
      movement('Dividendo', 'credit', 'SIMH3', '2024-10-01', '20', '0.50'),
      ...alzr(),
    ]);

    expect(again.outcome).toMatchObject({ applied: 3, resolvedCorporateEvents: 1 });
    expect(await transactionOf(deps, first.batchId, 'Grupamento')).toMatchObject({
      status: 'unclassified',
      isUserModified: false,
    });
    expect((await rowOf(deps, first.batchId, 'Grupamento')).classification).toBe('unclassified');
    expect((await transactionOf(deps, again.batchId, 'Dividendo')).status).toBe('active');
    // 220 − 200 = 20 SIMH3; 700 ALZR11.
    expect((await positionOf(deps, 'SIMH3'))?.quantity.toString()).toBe('20');
    expect((await positionOf(deps, 'ALZR11'))?.quantity.toString()).toBe('700');
  });

  it('BR-005-24 (amended): a Posição discrepancy is blamed on the ledger’s unclassified Desdobro', async () => {
    // Movimentação: 70 ALZR11 and a Desdobro no factor confirms — the ledger
    // replays 70; B3 holds 700.
    const deps = buildFakeIngestionDeps();
    await importFile(deps, alzr());
    const posicao = await stagedBatch(deps, {
      extractType: 'b3_posicao',
      records: [
        {
          raw: { Produto: 'ALZR11' },
          record: {
            kind: 'position',
            assetCode: 'ALZR11',
            assetName: 'ALZR11',
            assetClass: 'fii',
            institutionName: 'Corretora Teste',
            quantity: Quantity.fromString('700'),
            fixedIncome: null,
          },
        },
      ],
    });

    const result = await commitBatch(deps, userId, {
      batchId: posicao,
      asOf: BusinessDate.of('2026-03-01'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [discrepancy] = result.value.batch.reconciliation?.discrepancies ?? [];
    expect(discrepancy).toMatchObject({ cause: 'unclassified_rows_affecting_asset' });
    expect(discrepancy?.computedQuantity.toString()).toBe('70');
  });
});
