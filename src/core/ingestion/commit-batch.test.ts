import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { editTransaction } from '@/core/ledger/edit-transaction';
import {
  computeTotalValue,
  type Transaction,
  type TransactionType,
} from '@/core/ledger/transaction';
import { replayPosition } from '@/core/positions/replay';
import type {
  ImportBatch,
  NormalizedTransactionRecord,
  ParsedExtract,
  ParsedRecord,
} from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
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

  it('carries nothing from a debit whose own source group fails, and writes neither', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    // ORIGEM holds 100: the transfer of 100 and a sale of 100 two days later
    // cannot both happen, so the group is invalid — and so no cost leaves it.
    const { outcome } = await importFile(deps, [
      credit(),
      debit(),
      buy({
        b3Type: 'Venda',
        institutionName: ORIGEM,
        tradeDate: BusinessDate.of('2026-03-12'),
      }),
    ]);

    expect(outcome.invalid).toBe(2);
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
    expect(deps.transactions.rows.filter((t) => t.type === 'transfer_out')).toHaveLength(0);
  });

  it('falls back to unclassified when the destination group fails for another row', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    // DESTINO would hold 100 carried; a sale of 150 there fails the group.
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
    expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
    const rows = await deps.rows.listByBatch(batchId);
    expect(rows.map((row) => row.classification)).toEqual(['unclassified', 'new', 'invalid']);
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
    expect(first.outcome.batch.rowCounts).toMatchObject({ new: 3, needsAttention: 3 });

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
    // BR-005-10: the first batch's stored counts follow its rows — 3 + 3 new, 3 − 3 attention.
    expect((await deps.batches.findById(first.batchId))?.rowCounts).toMatchObject({
      new: 6,
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
