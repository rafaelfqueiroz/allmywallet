import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import type {
  NormalizedTransactionRecord,
  ParsedExtract,
  ParsedRecord,
} from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function transactionRecord(overrides: Partial<NormalizedTransactionRecord> = {}): ParsedRecord {
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

async function seedPendingBatch(deps: ReturnType<typeof buildFakeIngestionDeps>) {
  const batchId = ImportBatchId.generate();
  deps.batches.seed({
    id: batchId,
    userId,
    source: 'b3_movimentacao',
    status: 'pending',
    uploadedAt: new Date('2026-03-15T00:00:00Z'),
    committedAt: null,
    rowCounts: null,
    reconciliation: null,
  });
  return batchId;
}

describe('SPEC-005 BR-005-09..11 — stageBatch', () => {
  it('BR-005-09: stages rows and moves the batch to previewed, writing nothing to the ledger', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [transactionRecord()],
    };

    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.batch.status).toBe('previewed');
    expect(deps.transactions.insertCount).toBe(0);
    expect(deps.rows.all).toHaveLength(1);
  });

  it('BR-005-10: the preview summary counts rows read, new, duplicates and needs-attention, and the date range', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [
        transactionRecord({ tradeDate: BusinessDate.of('2026-01-05') }),
        transactionRecord({
          b3Type: 'Um Tipo Desconhecido',
          tradeDate: BusinessDate.of('2026-01-20'),
        }),
      ],
    };

    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toEqual({
      read: 2,
      new: 1,
      duplicates: 0,
      needsAttention: 1,
      fromDate: BusinessDate.of('2026-01-05'),
      toDate: BusinessDate.of('2026-01-20'),
    });
  });

  it('BR-005-19/21: an unmapped movement type stages as unclassified and is reported for logging (no values)', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [transactionRecord({ b3Type: 'Baixa Por Liquidação Antecipada' })],
    };

    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0]?.classification).toBe('unclassified');
    expect(result.value.unmappedTypes).toEqual(['Baixa Por Liquidação Antecipada']);
  });

  it('BR-005-16: two genuine identical same-day trades both stage as new', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [transactionRecord(), transactionRecord()],
    };

    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.classification)).toEqual(['new', 'new']);
    expect(result.value.rows.map((r) => r.occurrence)).toEqual([1, 2]);
  });

  it('BR-005-17: staging the same file again reports both rows as duplicates once committed history exists', async () => {
    const deps = buildFakeIngestionDeps();

    // Simulate a prior committed import: two occurrences of the same natural
    // key already sit in the ledger.
    const first = transactionRecord();
    const assetId = await deps.assets.resolve({
      code: first.record.assetCode,
      name: first.record.assetName,
      assetClass: first.record.assetClass,
    });
    const institutionId = await deps.institutions.resolve(first.record.institutionName as string);
    const key = naturalKeyFor({
      assetId,
      institutionId,
      type: 'buy',
      tradeDate: (first.record as NormalizedTransactionRecord).tradeDate,
      quantity: (first.record as NormalizedTransactionRecord).quantity,
      unitPrice: (first.record as NormalizedTransactionRecord).unitPrice,
    });
    for (const occurrence of [1, 2]) {
      await deps.transactions.insert({
        id: TransactionId.generate(),
        userId,
        assetId,
        institutionId,
        type: 'buy',
        status: 'active',
        tradeDate: (first.record as NormalizedTransactionRecord).tradeDate,
        quantity: (first.record as NormalizedTransactionRecord).quantity,
        unitPrice: (first.record as NormalizedTransactionRecord).unitPrice,
        fees: Money.zero(),
        totalValue: Money.fromString('3219.90'),
        ratio: null,
        naturalKey: key,
        occurrence,
        importBatchId: null,
        isManual: false,
        isUserModified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [transactionRecord(), transactionRecord()],
    };
    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.classification)).toEqual(['duplicate', 'duplicate']);
    expect(result.value.counts).toMatchObject({ new: 0, duplicates: 2 });
  });

  it('BR-005-06: a Posição row with fixed-income details stages as classification "position"', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const extract: ParsedExtract = {
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
    };

    const result = await stageBatch(deps, userId, { batchId, extract });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0]?.classification).toBe('position');
    expect(result.value.rows[0]?.naturalKey).toBeNull();
  });

  it('refuses to stage a batch that is not pending', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    await stageBatch(deps, userId, {
      batchId,
      extract: { extractType: 'b3_movimentacao', records: [transactionRecord()] },
    });

    const result = await stageBatch(deps, userId, {
      batchId,
      extract: { extractType: 'b3_movimentacao', records: [transactionRecord()] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_BATCH_NOT_PENDING');
  });

  it('refuses to stage an extract with zero records', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await seedPendingBatch(deps);
    const result = await stageBatch(deps, userId, {
      batchId,
      extract: { extractType: 'b3_movimentacao', records: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_EMPTY_EXTRACT');
  });
});
