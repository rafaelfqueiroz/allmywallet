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
            asOf: BusinessDate.of('2026-03-01'),
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

    const result = await commitBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.fixedIncomeContracts.calls).toHaveLength(1);
    expect(result.value.batch.reconciliation).not.toBeNull();
    // The ledger holds none of this CDB — a clean discrepancy against B3's 1.
    expect(result.value.batch.reconciliation?.status).toBe('discrepancies_found');
    expect(result.value.batch.reconciliation?.discrepancies[0]?.cause).toBe(
      'missing_history_before_import_range',
    );
  });
});
