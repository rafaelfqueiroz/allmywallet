import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { cancelBatch } from '@/core/ingestion/cancel-batch';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function buy(): { raw: Record<string, string>; record: NormalizedTransactionRecord } {
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
  };
  return { raw: { Movimentação: record.b3Type }, record };
}

describe('SPEC-005 BR-005-12 — cancelBatch', () => {
  it('removes staged rows and marks the batch discarded, writing nothing to the ledger', async () => {
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
    const extract: ParsedExtract = { extractType: 'b3_movimentacao', records: [buy()] };
    await stageBatch(deps, userId, { batchId, extract });
    expect(deps.rows.all).toHaveLength(1);

    const result = await cancelBatch(deps, userId, { batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removedRows).toBe(1);
    expect(result.value.batch.status).toBe('discarded');
    expect(deps.rows.all).toHaveLength(0);
    expect(deps.transactions.insertCount).toBe(0);
  });

  it('refuses to cancel a batch that has already been committed', async () => {
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
    const extract: ParsedExtract = { extractType: 'b3_movimentacao', records: [buy()] };
    await stageBatch(deps, userId, { batchId, extract });
    await commitBatch(deps, userId, { batchId });

    const result = await cancelBatch(deps, userId, { batchId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_CANCELLABLE');
  });
});
