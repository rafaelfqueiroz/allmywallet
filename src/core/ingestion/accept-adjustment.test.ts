import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { NormalizedPositionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { acceptReconciliationAdjustment } from '@/core/ingestion/accept-adjustment';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

describe('SPEC-005 BR-005-25 — acceptReconciliationAdjustment', () => {
  it('creates a dated adjustment transaction and marks the discrepancy resolved, never editing history', async () => {
    const deps = buildFakeIngestionDeps();
    const assetId = await deps.assets.resolve({
      code: 'HGLG11',
      name: 'CSHG Logística',
      assetClass: 'fii',
    });

    const positionRecord: NormalizedPositionRecord = {
      kind: 'position',
      assetCode: 'HGLG11',
      assetName: 'CSHG Logística',
      assetClass: 'fii',
      institutionName: null,
      quantity: Quantity.fromString('50'),
      asOf: BusinessDate.of('2026-03-01'),
      fixedIncome: null,
    };
    const batchId = ImportBatchId.generate();
    deps.batches.seed({
      id: batchId,
      userId,
      source: 'b3_posicao',
      status: 'pending',
      uploadedAt: new Date(),
      committedAt: null,
      rowCounts: null,
      reconciliation: null,
    });
    const extract: ParsedExtract = {
      extractType: 'b3_posicao',
      records: [{ raw: { Produto: 'HGLG11' }, record: positionRecord }],
    };
    await stageBatch(deps, userId, { batchId, extract });
    const committed = await commitBatch(deps, userId, { batchId });
    if (!committed.ok) throw new Error('commit failed in test setup');
    expect(committed.value.batch.reconciliation?.discrepancies).toHaveLength(1);

    const transactionCountBefore = deps.transactions.insertCount;
    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId,
      institutionId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.transaction.type).toBe('adjustment');
    expect(result.value.result.transaction.quantity.toString()).toBe('50');
    expect(result.value.result.transaction.tradeDate).toBe('2026-03-01');
    expect(deps.transactions.insertCount).toBe(transactionCountBefore + 1);
    expect(result.value.batch.reconciliation?.discrepancies[0]?.resolved).toBe(true);

    // History is untouched — the original absence of any HGLG11 transaction
    // is still exactly that; a new row was added, nothing was edited.
    expect(deps.transactions.rows.filter((t) => t.type !== 'adjustment')).toHaveLength(0);
  });

  it('refuses when the discrepancy is already resolved or does not exist', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = ImportBatchId.generate();
    deps.batches.seed({
      id: batchId,
      userId,
      source: 'b3_posicao',
      status: 'committed',
      uploadedAt: new Date(),
      committedAt: new Date(),
      rowCounts: null,
      reconciliation: {
        asOf: BusinessDate.of('2026-03-01'),
        discrepancies: [],
        status: 'reconciled',
      },
    });

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await deps.assets.resolve({ code: 'X', name: 'X', assetClass: 'stock' }),
      institutionId: null,
    });
    expect(result.ok).toBe(false);
  });
});
