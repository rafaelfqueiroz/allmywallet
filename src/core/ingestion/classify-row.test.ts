import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function unmapped(): { raw: Record<string, string>; record: NormalizedTransactionRecord } {
  const record: NormalizedTransactionRecord = {
    kind: 'transaction',
    b3Type: 'Um Tipo Novo',
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

async function committedUnclassifiedRow(deps: FakeIngestionDeps) {
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
  const extract: ParsedExtract = { extractType: 'b3_movimentacao', records: [unmapped()] };
  await stageBatch(deps, userId, { batchId, extract });
  await commitBatch(deps, userId, { batchId });
  const row = deps.rows.all.find((r) => r.batchId === batchId);
  if (!row) throw new Error('row not found in test setup');
  return row;
}

describe('SPEC-005 BR-005-20 — classifyImportRow', () => {
  it('brings an unclassified row into calculations and recalculates the position', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await committedUnclassifiedRow(deps);
    expect(deps.positions.upsertCount).toBe(0);

    const result = await classifyImportRow(deps, { rowId: row.id, type: 'buy' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction.status).toBe('active');
    expect(result.value.transaction.type).toBe('buy');
    // BR-006-16: protected from a later re-import reverting the classification.
    expect(result.value.transaction.isUserModified).toBe(true);
    expect(deps.positions.upsertCount).toBeGreaterThan(0);

    const updatedRow = await deps.rows.findById(row.id);
    expect(updatedRow?.classification).toBe('new');
  });

  it('refuses to classify a row that is not unclassified', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await committedUnclassifiedRow(deps);
    await classifyImportRow(deps, { rowId: row.id, type: 'buy' });

    const result = await classifyImportRow(deps, { rowId: row.id, type: 'sell' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
  });
});
