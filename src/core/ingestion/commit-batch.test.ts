import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';

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
