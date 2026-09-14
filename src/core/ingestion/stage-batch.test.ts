import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  type AssetId,
  ImportBatchId,
  type InstitutionId,
  TransactionId,
  UserId,
} from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import type { Transaction } from '@/core/ledger/transaction';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import { commitBatch } from '@/core/ingestion/commit-batch';
import { UNCLASSIFIED_PLACEHOLDER_TYPE, importNaturalKeyFor } from '@/core/ingestion/occurrence';
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

function priceParts(record: NormalizedTransactionRecord) {
  return { tradeDate: record.tradeDate, quantity: record.quantity, unitPrice: record.unitPrice };
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
    failureCode: null,
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
      ignored: 0,
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

  describe('BR-005-19 (amended, #110) — rows mirroring another extract', () => {
    it('stages them ignored, in file order, outside Needs attention and the unmapped log', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await seedPendingBatch(deps);
      const settlement = { b3Type: 'Transferência - Liquidação', priceStated: false } as const;
      const extract: ParsedExtract = {
        extractType: 'b3_movimentacao',
        records: [
          transactionRecord({ ...settlement, direction: 'credit' }),
          transactionRecord({ ...settlement, direction: 'debit' }),
          transactionRecord({ b3Type: 'Dividendo', quantity: Quantity.fromString('7') }),
          transactionRecord({ b3Type: 'Dividendo - Transferido', direction: 'credit' }),
        ],
      };

      const result = await stageBatch(deps, userId, { batchId, extract });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rows.map((row) => row.classification)).toEqual([
        'ignored',
        'ignored',
        'new',
        'ignored',
      ]);
      expect(
        result.value.rows.map((row) => row.record.kind === 'transaction' && row.record.b3Type),
      ).toEqual(
        extract.records.map(
          (parsed) => parsed.record.kind === 'transaction' && parsed.record.b3Type,
        ),
      );
      // Same asset, date, quantity and price in both directions: ordinals 1, 2.
      expect(result.value.rows.map((row) => row.occurrence)).toEqual([1, 2, 1, 1]);
      expect(result.value.counts).toMatchObject({ read: 4, new: 1, needsAttention: 0, ignored: 3 });
      expect(result.value.unmappedTypes).toEqual([]);
    });

    it('takes no occurrence slot, so the Negociação trade it mirrors is not made a duplicate', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await seedPendingBatch(deps);
      const extract: ParsedExtract = {
        extractType: 'b3_movimentacao',
        records: [
          transactionRecord({ b3Type: 'Transferência - Liquidação', direction: 'credit' }),
          transactionRecord(),
        ],
      };

      const result = await stageBatch(deps, userId, { batchId, extract });

      if (!result.ok) throw new Error('stage failed');
      expect(result.value.rows[1]).toMatchObject({ classification: 'new', occurrence: 1 });
    });
  });

  describe('#110 — BR-005-17 across key forms', () => {
    async function seedLedgerRow(
      deps: ReturnType<typeof buildFakeIngestionDeps>,
      record: NormalizedTransactionRecord,
      naturalKey: (ids: { assetId: AssetId; institutionId: InstitutionId }) => string,
      overrides: Partial<Transaction> = {},
    ) {
      const assetId = await deps.assets.resolve({
        code: record.assetCode,
        name: record.assetName,
        assetClass: record.assetClass,
        classStated: false,
        nameStated: true,
      });
      const institutionId = await deps.institutions.resolve(record.institutionName as string);
      await deps.transactions.insert({
        ...aTransaction().rendimento().on(record.tradeDate).quantity('100').price('10').build(),
        assetId,
        institutionId,
        status: 'unclassified',
        naturalKey: naturalKey({ assetId, institutionId }),
        occurrence: 1,
        ...overrides,
      });
      return { assetId, institutionId };
    }

    it('a row committed unmapped under map v2 stages as a duplicate under v3, not a second buy', async () => {
      const deps = buildFakeIngestionDeps();
      const aplicacao = transactionRecord({ b3Type: 'APLICAÇÃO', direction: 'credit' })
        .record as NormalizedTransactionRecord;
      await seedLedgerRow(deps, aplicacao, (ids) =>
        importNaturalKeyFor(
          { ...ids, ...priceParts(aplicacao), type: UNCLASSIFIED_PLACEHOLDER_TYPE },
          'APLICAÇÃO',
        ),
      );

      const batchId = await seedPendingBatch(deps);
      const result = await stageBatch(deps, userId, {
        batchId,
        extract: { extractType: 'b3_movimentacao', records: [{ raw: {}, record: aplicacao }] },
      });

      if (!result.ok) throw new Error('stage failed');
      expect(result.value.rows[0]?.classification).toBe('duplicate');
    });

    it('a price-less transfer carries the source cost, and a re-import of the file is a duplicate', async () => {
      const deps = buildFakeIngestionDeps();
      const credit = transactionRecord({
        b3Type: 'Transferência',
        direction: 'credit',
        institutionName: 'Corretora Destino',
        priceStated: false,
        unitPrice: Money.zero(),
        fees: Money.zero(),
      }).record as NormalizedTransactionRecord;
      const debitRecord = {
        ...credit,
        direction: 'debit',
        institutionName: 'Corretora Origem',
      } as const;

      // The source broker's history: 100 bought at 25,00 → preço médio 25,00.
      const sourceIds = await seedLedgerRow(
        deps,
        { ...debitRecord, tradeDate: BusinessDate.of('2026-01-02') },
        () => 'seeded-buy',
        {
          type: 'buy',
          status: 'active',
          unitPrice: Money.fromString('25'),
          fees: Money.zero(),
          tradeDate: BusinessDate.of('2026-01-02'),
        },
      );
      const records = [
        { raw: {}, record: credit },
        { raw: {}, record: debitRecord },
      ];

      const batchId = await seedPendingBatch(deps);
      const first = await stageBatch(deps, userId, {
        batchId,
        extract: { extractType: 'b3_movimentacao', records },
      });
      if (!first.ok) throw new Error('stage failed');
      const [transferIn, transferOut] = first.value.rows;
      expect(transferIn).toMatchObject({ classification: 'new', ledgerType: 'transfer_in' });
      expect(
        transferIn?.record.kind === 'transaction' &&
          transferIn.record.unitPrice.equals(Money.fromString('25')),
      ).toBe(true);
      expect(transferOut).toMatchObject({ classification: 'new', ledgerType: 'transfer_out' });

      await commitBatch(deps, userId, { batchId });
      expect(
        deps.transactions.rows.filter(
          (t) => t.assetId === sourceIds.assetId && t.status === 'active',
        ),
      ).toHaveLength(3);

      const again = await seedPendingBatch(deps);
      const second = await stageBatch(deps, userId, {
        batchId: again,
        extract: { extractType: 'b3_movimentacao', records },
      });
      if (!second.ok) throw new Error('stage failed');
      expect(second.value.rows.map((row) => row.classification)).toEqual([
        'duplicate',
        'duplicate',
      ]);
    });

    it('a price-less transfer with no source debit stays unclassified', async () => {
      const deps = buildFakeIngestionDeps();
      const batchId = await seedPendingBatch(deps);
      const result = await stageBatch(deps, userId, {
        batchId,
        extract: {
          extractType: 'b3_movimentacao',
          records: [
            transactionRecord({
              b3Type: 'Transferência',
              direction: 'credit',
              priceStated: false,
              unitPrice: Money.zero(),
            }),
          ],
        },
      });

      if (!result.ok) throw new Error('stage failed');
      expect(result.value.rows[0]?.classification).toBe('unclassified');
    });
  });

  describe('#108 — a mapped row the extract gave no price', () => {
    async function stageOne(overrides: Partial<NormalizedTransactionRecord>) {
      const deps = buildFakeIngestionDeps();
      const batchId = await seedPendingBatch(deps);
      const result = await stageBatch(deps, userId, {
        batchId,
        extract: { extractType: 'b3_movimentacao', records: [transactionRecord(overrides)] },
      });
      if (!result.ok) throw new Error('stage failed in test setup');
      return result.value.rows[0]?.classification;
    }

    it.each([
      ['Transferência', 'credit'],
      ['Compra', null],
      ['Dividendo', null],
      ['Direitos de Subscrição - Exercido', null],
    ] as const)(
      '%s with no price stages unclassified, never at a zero price',
      async (b3Type, direction) => {
        expect(
          await stageOne({ b3Type, direction, priceStated: false, unitPrice: Money.zero() }),
        ).toBe('unclassified');
      },
    );

    it.each([
      ['Transferência', 'debit'],
      ['Bonificação em Ativos', null],
    ] as const)('%s needs no price and still stages as new', async (b3Type, direction) => {
      expect(
        await stageOne({ b3Type, direction, priceStated: false, unitPrice: Money.zero() }),
      ).toBe('new');
    });
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
      classStated: false,
      nameStated: true,
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
