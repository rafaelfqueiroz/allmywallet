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
import { explainRefusal } from '@/core/ingestion/refusal';
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

describe('SPEC-005 BR-005-20c — asset-conversion commit', () => {
  function evidence(
    b3Type: 'Atualização' | 'Resgate' | 'Incorporação',
    assetCode: string,
    tradeDate: string,
    quantity: string,
    institutionName = 'Corretora Teste',
  ): ParsedRecord {
    return buy({
      b3Type,
      direction: b3Type === 'Resgate' ? 'debit' : 'credit',
      assetCode,
      assetName: assetCode,
      institutionName,
      tradeDate: BusinessDate.of(tradeDate),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.zero(),
      fees: Money.zero(),
      priceStated: false,
    });
  }

  async function importRows(deps: FakeIngestionDeps, records: readonly ParsedRecord[]) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId });
    if (!result.ok) throw new Error(result.error.code);
    return { batchId, outcome: result.value };
  }

  it('moves ELET3 260 at exact cost to AXIA3 from target-only Atualização, then re-imports as a no-op', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'ELET3',
        assetName: 'ELET3',
        tradeDate: BusinessDate.of('2025-01-02'),
        quantity: Quantity.fromString('260'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const file = [evidence('Atualização', 'AXIA3', '2025-02-03', '260')];
    const first = await importRows(deps, file);

    expect(first.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 2,
    });
    const legs = deps.transactions.rows.filter((row) => row.conversionGroupId !== null);
    expect(legs.map((row) => row.type).sort()).toEqual(['conversion_in', 'conversion_out']);
    expect(new Set(legs.map((row) => row.conversionGroupId))).toHaveLength(1);
    expect(legs.every((row) => row.totalValue.isZero())).toBe(true);
    expect(legs.find((row) => row.type === 'conversion_in')?.costBasis?.toString()).toBe('2600');

    const eletId = await deps.assets.resolve({
      code: 'ELET3',
      name: 'ELET3',
      assetClass: 'stock',
      classStated: false,
      nameStated: false,
    });
    const axiaId = await deps.assets.resolve({
      code: 'AXIA3',
      name: 'AXIA3',
      assetClass: 'stock',
      classStated: false,
      nameStated: false,
    });
    const elet = replayPosition(
      await deps.transactions.listForPosition(eletId, legs[0]?.institutionId ?? null),
    );
    const axia = replayPosition(
      await deps.transactions.listForPosition(axiaId, legs[0]?.institutionId ?? null),
    );
    expect(elet.ok && elet.value.quantity.toString()).toBe('0');
    expect(elet.ok && elet.value.realizedGain.toString()).toBe('0');
    expect(axia.ok && axia.value.quantity.toString()).toBe('260');
    expect(axia.ok && axia.value.totalCost.toString()).toBe('2600');

    const transactionCount = deps.transactions.rows.length;
    const second = await importRows(deps, file);
    expect(second.outcome).toMatchObject({
      applied: 0,
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(transactionCount);
  });

  it('promotes stored evidence in place, keeps its key and inserts its companion exactly once', async () => {
    const deps = buildFakeIngestionDeps();
    const file = [evidence('Atualização', 'AXIA3', '2025-02-03', '260')];
    const unresolved = await importRows(deps, file);
    const stored = deps.transactions.rows[0];
    expect(stored).toMatchObject({ status: 'unclassified', isUserModified: false });

    await importRows(deps, [
      buy({
        assetCode: 'ELET3',
        assetName: 'ELET3',
        tradeDate: BusinessDate.of('2025-01-02'),
        quantity: Quantity.fromString('260'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const resolved = await importRows(deps, file);
    expect(resolved.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 2,
    });
    const promoted = deps.transactions.rows.find((row) => row.id === stored?.id);
    expect(promoted).toMatchObject({
      type: 'conversion_in',
      status: 'active',
      naturalKey: stored?.naturalKey,
      importBatchId: unresolved.batchId,
      isUserModified: false,
    });
    expect((await deps.rows.listByBatch(unresolved.batchId))[0]?.classification).toBe('new');
    const afterPromotion = deps.transactions.rows.length;
    const again = await importRows(deps, file);
    expect(again.outcome).toMatchObject({
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(afterPromotion);
  });

  it('resolves CPLE6 175 to its targets when the statements precede a source Resgate', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'CPLE6',
        assetName: 'CPLE6',
        tradeDate: BusinessDate.of('2025-01-02'),
        quantity: Quantity.fromString('175'),
        unitPrice: Money.fromString('8'),
        fees: Money.zero(),
      }),
    ]);
    const result = await importRows(deps, [
      evidence('Atualização', 'CPLE3', '2025-02-01', '175'),
      evidence('Atualização', 'CPLE7', '2025-02-01', '175'),
      evidence('Resgate', 'CPLE6', '2025-02-10', '175'),
    ]);

    expect(result.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 3,
    });
    // #129 D3: 175 @ 8,00 = 1.400,00, all of it on CPLE3; CPLE7's weight is zero.
    const legOf = async (code: string) => {
      const assetId = await deps.assets.resolve({
        code,
        name: code,
        assetClass: 'stock',
        classStated: false,
        nameStated: false,
      });
      return deps.transactions.rows.find(
        (row) => row.conversionGroupId !== null && row.assetId === assetId,
      );
    };
    expect((await legOf('CPLE3'))?.costBasis?.toString()).toBe('1400');
    expect((await legOf('CPLE7'))?.costBasis?.toString()).toBe('0');
  });

  /**
   * #129 D2/D3 — the owner's real CPLE shape, generated (DV-24 / TS-19).
   *
   * `cple7-to-cple3` could never match it: CPLE7 holds no position. It appears
   * only as an `Atualização` balance statement — evidence, never an
   * acquisition (BR-005-20c) — so `resolveAssetConversion` refused
   * `insufficient_quantity` and gave up the group. CPLE3 computed **0**
   * against B3's 175.
   *
   * B3's record is the source of truth, and it states three things: 175 CPLE3
   * and 175 CPLE7 held on 2025-12-23, **with no value attributed to either**,
   * and 175 CPLE7 disposed of for a stated 0,775 a week later. So the group is
   * sourced from CPLE6 and CPLE7 joins it at weight **zero** — the same
   * reading a bonificação takes of a quantity B3 states without a price.
   *
   * Hand-computed (DV-17): 100 at 7,39 = 739,00 plus 75 at 8,11 = 608,25 →
   * 175 held at **1.347,25**, all of it carried into CPLE3 and none into
   * CPLE7. The redemption is then a sale of 175 at 0,775 = **135,625** exactly
   * against a basis of 0,00, realising 135,625 in full.
   *
   * Value-weighting instead would give CPLE7 a basis of 135,625 and CPLE3 one
   * of 1.211,625 — but the **total** realised gain across the redemption and
   * an eventual CPLE3 sale is identical either way, so the zero weight moves
   * only when the gain is recognised, and invents no price B3 withheld.
   */
  it('#129: carries all CPLE6 cost to CPLE3 and realises the CPLE7 redemption in full', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const file = [
      buy({
        assetCode: 'CPLE6',
        assetName: 'CPLE6',
        tradeDate: BusinessDate.of('2022-02-11'),
        quantity: Quantity.fromString('100'),
        unitPrice: Money.fromString('7.39'),
        fees: Money.zero(),
      }),
      buy({
        assetCode: 'CPLE6',
        assetName: 'CPLE6',
        tradeDate: BusinessDate.of('2023-07-14'),
        quantity: Quantity.fromString('75'),
        unitPrice: Money.fromString('8.11'),
        fees: Money.zero(),
      }),
      evidence('Atualização', 'CPLE7', '2025-12-23', '175'),
      evidence('Atualização', 'CPLE3', '2025-12-23', '175'),
      buy({
        b3Type: 'Resgate',
        direction: 'debit',
        assetCode: 'CPLE7',
        assetName: 'CPLE7',
        tradeDate: BusinessDate.of('2025-12-30'),
        quantity: Quantity.fromString('175'),
        unitPrice: Money.fromString('0.775'),
        fees: Money.zero(),
      }),
    ];

    const first = await importRows(deps, file);
    expect(first.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 3,
    });

    const institution = await deps.institutions.resolve('Corretora Teste');
    const assetOf = (code: string) =>
      deps.assets.resolve({
        code,
        name: code,
        assetClass: 'stock',
        classStated: false,
        nameStated: false,
      });
    const replayedOf = async (code: string) =>
      replayPosition(await deps.transactions.listForPosition(await assetOf(code), institution));

    const cple3 = await replayedOf('CPLE3');
    const cple6 = await replayedOf('CPLE6');
    const cple7 = await replayedOf('CPLE7');
    expect(cple3.ok && cple3.value.quantity.toString()).toBe('175');
    expect(cple3.ok && cple3.value.totalCost.toString()).toBe('1347.25');
    expect(cple6.ok && cple6.value.quantity.toString()).toBe('0');
    expect(cple6.ok && cple6.value.realizedGain.toString()).toBe('0');

    // B3 priced the redemption, so it is the sale B3 says it is: 175 units
    // leave and 175 × 0,775 = 135,625 is realised against a zero basis.
    expect(cple7.ok && cple7.value.quantity.toString()).toBe('0');
    expect(cple7.ok && cple7.value.realizedGain.toString()).toBe('135.625');

    const legOf = async (code: string) => {
      const assetId = await assetOf(code);
      const leg = deps.transactions.rows.find(
        (row) => row.conversionGroupId !== null && row.assetId === assetId,
      );
      return [leg?.type, leg?.quantity.toString(), leg?.costBasis?.toString()];
    };
    expect(await legOf('CPLE6')).toEqual(['conversion_out', '175', '1347.25']);
    expect(await legOf('CPLE3')).toEqual(['conversion_in', '175', '1347.25']);
    expect(await legOf('CPLE7')).toEqual(['conversion_in', '175', '0']);

    // The redemption is applied, not refused — the defect this closes.
    const rows = await deps.rows.listByBatch(first.batchId);
    const redemption = rows.find(
      (row) => row.record.kind === 'transaction' && row.record.b3Type === 'Resgate',
    );
    expect(redemption?.classification).toBe('new');

    // BR-005-17/20: the same file again changes nothing.
    const beforeReimport = deps.transactions.rows.length;
    const second = await importRows(deps, file);
    expect(second.outcome).toMatchObject({
      applied: 0,
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  /**
   * #128 D1/D2/D3 — the whole AXIA chain from one full-history Movimentação.
   *
   * A **generated** fixture in the shape of the owner's real file (DV-24 /
   * TS-19: no extract, no CPF, no captured row ever enters the repository).
   * It is the acceptance test for all three defects at once, because each one
   * alone still lands AXIA7 on the wrong number:
   *
   * - D1 — the bonificação (2025-12-23) and its `Fração em Ativos`
   *   (2026-02-09) are **48 calendar days** apart, so the old 45-day origin
   *   window refused the pair `no_origin` and AXIA7 kept the 0,34;
   * - D2 — conversions planned before that fraction settles replay AXIA7 as
   *   68,34 on 2026-08-11 and move 4,34 units instead of 4;
   * - D3 — a definition sourcing AXIA13 as well finds it holding 0 on
   *   2026-09-09 (its four units were redeemed for cash on 2026-08-24) and
   *   abandons the group `insufficient_quantity`, stranding AXIA7 at 64.
   *
   * Worked arithmetic (DV-17), all of it by hand:
   *
   * | date | AXIA7 | why |
   * |---|---|---|
   * | 2025-12-23 | 68,34 | bonificação, no attributed value → cost 0,00 |
   * | 2026-02-09 | 68 | `fracao_bonificacao` −0,34; total cost unchanged (BR-007-05a) |
   * | 2026-03-19 | 68 | `leilao_fracoes` 0,34 × 58,539 = **19,90326**, a provento — no quantity |
   * | 2026-06-22 | 68 | a pure balance statement: no target, stays `unclassified` |
   * | 2026-08-11 | 64 | 68 − 64 = **4** out to AXIA13 |
   * | 2026-09-09 | 52 | 64 − 52 = **12** out to AXIA15G |
   *
   * ELET3 260 @ 40,00 = 10.400,00 moves whole to AXIA3 on 2025-11-11, and
   * AXIA13's 4 units are sold on 2026-08-24 at 53,71: proceeds 214,84 against
   * a carried cost of 0,00, so realised gain is **214,84**.
   */
  it('#128: settles the fraction before measuring the AXIA conversions, and re-imports as a no-op', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const movement = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    const file = [
      movement('Compra', 'credit', 'ELET3', '2023-12-18', '260', '40'),
      movement('Atualização', 'credit', 'AXIA3', '2025-11-11', '260'),
      movement('Bonificação em Ativos', 'credit', 'AXIA7', '2025-12-23', '68.34'),
      movement('Fração em Ativos', 'debit', 'AXIA7', '2026-02-09', '0.34'),
      movement('Leilão de Fração', 'credit', 'AXIA7', '2026-03-19', '0.34', '58.539'),
      movement('Atualização', 'credit', 'AXIA7', '2026-06-22', '68'),
      movement('Atualização', 'credit', 'AXIA7', '2026-08-11', '64'),
      movement('Atualização', 'credit', 'AXIA13', '2026-08-11', '4'),
      movement('Resgate', 'credit', 'AXIA13', '2026-08-24', '4', '53.71'),
      movement('Atualização', 'credit', 'AXIA7', '2026-09-09', '52'),
      movement('Atualização', 'credit', 'AXIA15', '2026-09-09', '12'),
    ];

    const first = await importRows(deps, file);
    // ELET3 → AXIA3, AXIA7 → AXIA13, AXIA7 → AXIA15G: three groups, six legs.
    expect(first.outcome).toMatchObject({
      resolvedAssetConversions: 3,
      committedConversionLegs: 6,
      // The fraction and its auction (BR-005-20b).
      resolvedCorporateEvents: 2,
    });

    const institution = await deps.institutions.resolve('Corretora Teste');
    const assetOf = (code: string) =>
      deps.assets.resolve({
        code,
        name: code,
        assetClass: 'stock',
        classStated: false,
        nameStated: false,
      });
    const replayedOf = async (code: string) =>
      replayPosition(await deps.transactions.listForPosition(await assetOf(code), institution));
    const quantityOf = async (code: string) => {
      const replayed = await replayedOf(code);
      return replayed.ok ? replayed.value.quantity.toString() : 'unreplayable';
    };

    expect(await quantityOf('ELET3')).toBe('0');
    expect(await quantityOf('AXIA3')).toBe('260');
    expect(await quantityOf('AXIA7')).toBe('52');
    expect(await quantityOf('AXIA13')).toBe('0');
    expect(await quantityOf('AXIA15G')).toBe('12');

    // The two legs the defect got wrong: 4 rather than 68,34 − 64 = 4,34.
    const axia7 = await assetOf('AXIA7');
    const outgoing = deps.transactions.rows
      .filter((row) => row.assetId === axia7 && row.type === 'conversion_out')
      .map((row) => [row.tradeDate, row.quantity.toString(), row.costBasis?.toString()]);
    expect(outgoing).toEqual([
      ['2026-08-11', '4', '0'],
      ['2026-09-09', '12', '0'],
    ]);

    // BR-007-05b: both legs persist the identical exact cost.
    const axia3 = await replayedOf('AXIA3');
    const elet3 = await replayedOf('ELET3');
    expect(elet3.ok && elet3.value.totalCost.toString()).toBe('0');
    expect(elet3.ok && elet3.value.realizedGain.toString()).toBe('0');
    expect(axia3.ok && axia3.value.totalCost.toString()).toBe('10400');
    const axia3Id = await assetOf('AXIA3');
    const intoAxia3 = deps.transactions.rows.find(
      (row) => row.assetId === axia3Id && row.type === 'conversion_in',
    );
    expect(intoAxia3?.costBasis?.toString()).toBe('10400');

    // BR-005-20b: the 0,34 pair D1's 45-day window used to refuse.
    const byDate = (tradeDate: string) =>
      deps.transactions.rows.find((row) => row.assetId === axia7 && row.tradeDate === tradeDate);
    expect(byDate('2026-02-09')).toMatchObject({
      type: 'fracao_bonificacao',
      status: 'active',
    });
    expect(byDate('2026-03-19')).toMatchObject({ type: 'leilao_fracoes', status: 'active' });
    // 0,34 × 58,539 = 19,90326 — a provento, so the position never moves.
    expect(byDate('2026-03-19')?.totalValue.toString()).toBe('19.90326');

    // A pure balance statement: 68 restates what the ledger already holds, no
    // target asset appears beside it, and nothing may be invented for it.
    expect(byDate('2026-06-22')).toMatchObject({ status: 'unclassified' });
    expect(byDate('2026-06-22')?.conversionGroupId).toBeNull();

    // 4 × 53,71 = 214,84 of proceeds against 0,00 of carried cost.
    const axia13 = await replayedOf('AXIA13');
    expect(axia13.ok && axia13.value.realizedGain.toString()).toBe('214.84');

    // BR-005-17/20: the same file again is a no-op, v2 group keys and all.
    const beforeReimport = deps.transactions.rows.length;
    const second = await importRows(deps, file);
    expect(second.outcome).toMatchObject({
      applied: 0,
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  /**
   * #128 D2, the cost-basis half. The chain above carries a zero-cost
   * bonificação, so both the right and the wrong outgoing quantity remove
   * 0,00. Here the position has a real average, and the two figures differ:
   *
   * - 68 @ 10,00 = 680,00; bonificação of 0,34 with no attributed value →
   *   68,34 held at 680,00;
   * - `fracao_bonificacao` −0,34 on 2026-02-09 (48 days after its origin, so
   *   D1's 60-day window is what lets it resolve at all) → 68 at 680,00;
   * - statement 64 on 2026-08-11 → 68 − 64 = **4** out, and
   *   680,00 × 4 ÷ 68 = **40,00** exactly.
   *
   * Measured against the unsettled 68,34 it would have been 4,34 units and
   * 680,00 × 4,34 ÷ 68,34 = 43,184079601… → 43,18407960 at the storage scale:
   * plausible, wrong, and undetectable on any screen. (Removing the second
   * planning pass turns this test's assertions into exactly those figures.)
   */
  it('#128: a conversion carries the cost of the post-fraction position, not the pre-fraction one', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const priceless = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    const result = await importRows(deps, [
      buy({
        assetCode: 'AXIA7',
        assetName: 'AXIA7',
        tradeDate: BusinessDate.of('2025-11-10'),
        quantity: Quantity.fromString('68'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
      priceless('Bonificação em Ativos', 'credit', 'AXIA7', '2025-12-23', '0.34'),
      priceless('Fração em Ativos', 'debit', 'AXIA7', '2026-02-09', '0.34'),
      priceless('Leilão de Fração', 'credit', 'AXIA7', '2026-03-19', '0.34', '58.539'),
      priceless('Atualização', 'credit', 'AXIA7', '2026-08-11', '64'),
      priceless('Atualização', 'credit', 'AXIA13', '2026-08-11', '4'),
    ]);

    expect(result.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 2,
    });
    const legs = deps.transactions.rows.filter((row) => row.conversionGroupId !== null);
    expect(
      legs.map((row) => [row.type, row.quantity.toString(), row.costBasis?.toString()]),
    ).toEqual([
      ['conversion_out', '4', '40'],
      ['conversion_in', '4', '40'],
    ]);
    const institution = await deps.institutions.resolve('Corretora Teste');
    const axia7 = replayPosition(
      await deps.transactions.listForPosition(
        await deps.assets.resolve({
          code: 'AXIA7',
          name: 'AXIA7',
          assetClass: 'stock',
          classStated: false,
          nameStated: false,
        }),
        institution,
      ),
    );
    // 68 − 4 = 64 at 680,00 − 40,00 = 640,00, so the average is still 10,00.
    expect(axia7.ok && axia7.value.quantity.toString()).toBe('64');
    expect(axia7.ok && axia7.value.totalCost.toString()).toBe('640');
    expect(axia7.ok && axia7.value.averageCost.toString()).toBe('10');
  });

  it('converts a fractional KLBN11 unit into repeated KLBN3/KLBN4 transfer credits atomically', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'KLBN11',
        assetName: 'KLBN11',
        tradeDate: BusinessDate.of('2025-12-19'),
        quantity: Quantity.fromString('0.6'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const transfer = (
      assetCode: string,
      direction: 'credit' | 'debit',
      quantity: string,
    ): ParsedRecord =>
      buy({
        b3Type: 'Transferência',
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of('2025-12-23'),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.zero(),
        fees: Money.zero(),
        priceStated: false,
      });
    const file = [
      transfer('KLBN11', 'debit', '0.6'),
      transfer('KLBN3', 'credit', '0.6'),
      transfer('KLBN4', 'credit', '2'),
      transfer('KLBN4', 'credit', '0.4'),
    ];

    const first = await importRows(deps, file);
    expect(first.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 4,
    });
    const legs = deps.transactions.rows.filter((row) => row.conversionGroupId !== null);
    expect(legs.map((row) => [row.type, row.costBasis?.toString()])).toEqual([
      ['conversion_out', '6'],
      ['conversion_in', '1.2'],
      ['conversion_in', '4'],
      ['conversion_in', '0.8'],
    ]);
    expect(legs.every((row) => row.importBatchId === first.batchId)).toBe(true);
    const beforeReimport = deps.transactions.rows.length;

    const second = await importRows(deps, file);
    expect(second.outcome).toMatchObject({
      applied: 0,
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  /**
   * #128 D2, the other direction of the mutual dependency. AXIA7's conversion
   * needs its fraction settled first; KLBN3's fraction needs its conversion
   * legs first, because the origin's `quantityAfter` is only right once the
   * 0,6 has arrived. A fix that merely swapped BR-005-20b and BR-005-20c
   * would trade one defect for this one, so it is pinned here.
   *
   * Hand-computed (DV-17): KLBN11 0,6 @ 10,00 = 6,00 total. One KLBN11 unit
   * holds 1 KLBN3 and 4 KLBN4, so 6,00 × 1 ÷ 5 = **1,20** to KLBN3 and the
   * residual 6,00 − 1,20 = **4,80** to KLBN4 (BR-005-20c: the last target
   * takes the storage-scale residual).
   *
   * KLBN3 then: 0,6 at 1,20 → bonificação +1 with no attributed value → 1,6
   * still at 1,20, whose fractional part is **0,6** — the unique origin of the
   * 0,6 `Fração em Ativos`. Without the conversion_in the position would be
   * 1,0 with a fractional part of 0, and the fraction would refuse
   * `no_origin`. The fraction leaves at unchanged total cost (BR-007-05a),
   * so 1,0 at 1,20 remains, and its auction is a 0,6 × 5,00 = **3,00**
   * `leilao_fracoes` provento (SPEC-014 BR-014-01).
   */
  it('#128: a KLBN3 fraction resolves against the conversion legs planned in the same commit', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'KLBN11',
        assetName: 'KLBN11',
        tradeDate: BusinessDate.of('2025-12-19'),
        quantity: Quantity.fromString('0.6'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const row = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    const result = await importRows(deps, [
      row('Transferência', 'debit', 'KLBN11', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN3', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '2.4'),
      row('Bonificação em Ativos', 'credit', 'KLBN3', '2026-01-05', '1'),
      row('Fração em Ativos', 'debit', 'KLBN3', '2026-01-22', '0.6'),
      row('Leilão de Fração', 'credit', 'KLBN3', '2026-02-10', '0.6', '5'),
    ]);

    expect(result.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 3,
      resolvedCorporateEvents: 2,
    });
    const institution = await deps.institutions.resolve('Corretora Teste');
    const assetOf = (code: string) =>
      deps.assets.resolve({
        code,
        name: code,
        assetClass: 'stock',
        classStated: false,
        nameStated: false,
      });
    // Looked up by asset rather than by insert order, which is the settling
    // rounds' grouping order and says nothing about the figures.
    const legOf = async (code: string) => {
      const assetId = await assetOf(code);
      const leg = deps.transactions.rows.find(
        (row_) => row_.conversionGroupId !== null && row_.assetId === assetId,
      );
      return [leg?.type, leg?.quantity.toString(), leg?.costBasis?.toString()];
    };
    expect(await legOf('KLBN11')).toEqual(['conversion_out', '0.6', '6']);
    expect(await legOf('KLBN3')).toEqual(['conversion_in', '0.6', '1.2']);
    expect(await legOf('KLBN4')).toEqual(['conversion_in', '2.4', '4.8']);
    const legs = deps.transactions.rows.filter((row_) => row_.conversionGroupId !== null);
    expect(new Set(legs.map((row_) => row_.conversionGroupId))).toHaveLength(1);

    const replayedOf = async (code: string) =>
      replayPosition(await deps.transactions.listForPosition(await assetOf(code), institution));
    const klbn11 = await replayedOf('KLBN11');
    const klbn3 = await replayedOf('KLBN3');
    const klbn4 = await replayedOf('KLBN4');
    expect(klbn11.ok && klbn11.value.quantity.toString()).toBe('0');
    expect(klbn3.ok && klbn3.value.quantity.toString()).toBe('1');
    expect(klbn3.ok && klbn3.value.totalCost.toString()).toBe('1.2');
    expect(klbn3.ok && klbn3.value.averageCost.toString()).toBe('1.2');
    expect(klbn4.ok && klbn4.value.quantity.toString()).toBe('2.4');
    expect(klbn4.ok && klbn4.value.totalCost.toString()).toBe('4.8');

    const fraction = deps.transactions.rows.find((row_) => row_.tradeDate === '2026-01-22');
    const auction = deps.transactions.rows.find((row_) => row_.tradeDate === '2026-02-10');
    expect(fraction).toMatchObject({ type: 'fracao_bonificacao', status: 'active' });
    expect(auction).toMatchObject({ type: 'leilao_fracoes', status: 'active' });
    expect(auction?.totalValue.toString()).toBe('3');
  });

  /**
   * #129 D1 — **a fraction on a conversion target**, the whole KLBN chain in
   * one generated file (DV-24 / TS-19: no extract, no CPF, no captured row).
   *
   * B3's bonificação left KLBN11 holding a fractional unit; B3 then decomposed
   * that unit into its component shares and auctioned the fractions off the
   * **targets**. KLBN3 and KLBN4 own no share-base event, so before this every
   * candidate list was empty, both `Fração em Ativos` rows refused `no_origin`,
   * and both auctions went with them — KLBN4 reconciled at 2,4 against B3's 2,
   * and KLBN3 silently kept 0,6 phantom shares B3 had sold.
   *
   * Hand-computed (DV-17), one institution:
   *
   * | date | what | KLBN11 | KLBN3 | KLBN4 |
   * |---|---|---|---|---|
   * | 2023-01-02 | buy 100 @ 10,66 → 1.066,00 | 100 | — | — |
   * | 2025-12-19 | bonificação +6,6, nothing attributed | 106,6 | — | — |
   * | 2025-12-23 | the fractional unit decomposes | 106 | 0,6 | 2,4 |
   * | 2026-01-22 | `Fração em Ativos` | 106 | 0 | 2 |
   * | 2026-02-24 | `Leilão de Fração` (a provento) | 106 | 0 | 2 |
   *
   * The cost: 1.066,00 ÷ 106,6 = **10,00** average, so the 0,6 unit carries
   * 6,00 out (BR-007-05b). One KLBN11 unit holds 1 KLBN3 and 4 KLBN4, so
   * 6,00 × 1 ÷ 5 = **1,20** to KLBN3 and the residual **4,80** to KLBN4.
   *
   * The trail (BR-005-20b): KLBN11 after its bonificação holds 106,6, leaving
   * **0,6** — exactly the group's outgoing quantity — so the origin is that
   * bonificação and both fractions are `fracao_bonificacao` (BR-007-05a):
   * total cost unchanged, nothing realised, each auction a `leilao_fracoes`
   * provento. KLBN3's whole holding leaves, closing the position and taking
   * its 1,20 with it; KLBN4 keeps 2 shares at 4,80, an average of 2,40.
   */
  it('#129: traces a fraction on a conversion target back to the source bonificação', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const row = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    const file = [
      buy({
        assetCode: 'KLBN11',
        assetName: 'KLBN11',
        tradeDate: BusinessDate.of('2023-01-02'),
        quantity: Quantity.fromString('100'),
        unitPrice: Money.fromString('10.66'),
        fees: Money.zero(),
      }),
      row('Bonificação em Ativos', 'credit', 'KLBN11', '2025-12-19', '6.6'),
      row('Transferência', 'debit', 'KLBN11', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN3', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '2'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '0.4'),
      row('Fração em Ativos', 'debit', 'KLBN3', '2026-01-22', '0.6'),
      row('Fração em Ativos', 'debit', 'KLBN4', '2026-01-22', '0.4'),
      row('Leilão de Fração', 'credit', 'KLBN3', '2026-02-24', '0.6', '3.942'),
      row('Leilão de Fração', 'credit', 'KLBN4', '2026-02-24', '0.4', '3.943'),
    ];

    const first = await importRows(deps, file);
    expect(first.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 4,
      // Two fractions and two auctions (BR-005-20b).
      resolvedCorporateEvents: 4,
    });

    const institution = await deps.institutions.resolve('Corretora Teste');
    const assetOf = (code: string) =>
      deps.assets.resolve({
        code,
        name: code,
        assetClass: 'stock',
        classStated: false,
        nameStated: false,
      });
    const replayedOf = async (code: string) =>
      replayPosition(await deps.transactions.listForPosition(await assetOf(code), institution));

    const klbn11 = await replayedOf('KLBN11');
    const klbn3 = await replayedOf('KLBN3');
    const klbn4 = await replayedOf('KLBN4');

    // The divergence the issue reports: KLBN4 computed 2,4 against B3's 2.
    expect(klbn4.ok && klbn4.value.quantity.toString()).toBe('2');
    expect(klbn4.ok && klbn4.value.totalCost.toString()).toBe('4.8');
    // BR-007-05a: total cost unchanged, so the average rises with the removal.
    expect(klbn4.ok && klbn4.value.averageCost.toString()).toBe('2.4');
    expect(klbn4.ok && klbn4.value.realizedGain.toString()).toBe('0');

    // The invisible half: absent from B3's Posição, so reconciliation never
    // reported it, and the ledger kept 0,6 shares B3 auctioned away.
    expect(klbn3.ok && klbn3.value.quantity.toString()).toBe('0');
    expect(klbn3.ok && klbn3.value.realizedGain.toString()).toBe('0');

    expect(klbn11.ok && klbn11.value.quantity.toString()).toBe('106');
    expect(klbn11.ok && klbn11.value.totalCost.toString()).toBe('1060');
    expect(klbn11.ok && klbn11.value.averageCost.toString()).toBe('10');

    const legOf = async (code: string) => {
      const assetId = await assetOf(code);
      const legs = deps.transactions.rows.filter(
        (r) => r.conversionGroupId !== null && r.assetId === assetId,
      );
      return legs.map((leg) => [leg.type, leg.quantity.toString(), leg.costBasis?.toString()]);
    };
    expect(await legOf('KLBN11')).toEqual([['conversion_out', '0.6', '6']]);
    expect(await legOf('KLBN3')).toEqual([['conversion_in', '0.6', '1.2']]);
    // Two same-day credits share the target's 4,80, the residual on the last.
    expect(await legOf('KLBN4')).toEqual([
      ['conversion_in', '2', '4'],
      ['conversion_in', '0.4', '0.8'],
    ]);

    const rowAt = async (code: string, tradeDate: string) => {
      const assetId = await assetOf(code);
      return deps.transactions.rows.find((r) => r.assetId === assetId && r.tradeDate === tradeDate);
    };
    for (const code of ['KLBN3', 'KLBN4']) {
      expect(await rowAt(code, '2026-01-22')).toMatchObject({
        type: 'fracao_bonificacao',
        status: 'active',
      });
      expect(await rowAt(code, '2026-02-24')).toMatchObject({
        type: 'leilao_fracoes',
        status: 'active',
      });
    }
    // 0,6 × 3,942 = 2,3652 and 0,4 × 3,943 = 1,5772 — proventos, not sales.
    expect((await rowAt('KLBN3', '2026-02-24'))?.totalValue.toString()).toBe('2.3652');
    expect((await rowAt('KLBN4', '2026-02-24'))?.totalValue.toString()).toBe('1.5772');

    // BR-005-17/20: the same file again changes nothing.
    const beforeReimport = deps.transactions.rows.length;
    const second = await importRows(deps, file);
    expect(second.outcome).toMatchObject({
      applied: 0,
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
      resolvedCorporateEvents: 0,
    });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  /**
   * #129 D1, the other arrival order. Above, the conversion and the fractions
   * it leaves come in one file, so the outgoing leg exists only as a plan. In
   * the owner's real history the Movimentação was imported in stages: the
   * group is already in the ledger, on a **different position**, and the
   * fraction's commit must read it and the source's own history from there.
   *
   * Same arithmetic as the chain above: KLBN11 106,6 at 1.066,00 leaves 0,6,
   * 6,00 of cost moves out, KLBN4 receives 2,4 at 4,80, and the 0,4 fraction
   * is a `fracao_bonificacao` leaving 2 shares at 4,80 — an average of 2,40.
   */
  it('#129: traces a fraction against a conversion group an earlier batch stored', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const row = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    const conversionFile = [
      buy({
        assetCode: 'KLBN11',
        assetName: 'KLBN11',
        tradeDate: BusinessDate.of('2023-01-02'),
        quantity: Quantity.fromString('100'),
        unitPrice: Money.fromString('10.66'),
        fees: Money.zero(),
      }),
      row('Bonificação em Ativos', 'credit', 'KLBN11', '2025-12-19', '6.6'),
      row('Transferência', 'debit', 'KLBN11', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN3', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '2'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '0.4'),
    ];
    const conversion = await importRows(deps, conversionFile);
    expect(conversion.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 4,
    });

    // A later file, holding the fractions alone. Neither KLBN11 nor the group
    // is mentioned in it; both are reached through the stored legs.
    const fractionFile = [
      row('Fração em Ativos', 'debit', 'KLBN4', '2026-01-22', '0.4'),
      row('Leilão de Fração', 'credit', 'KLBN4', '2026-02-24', '0.4', '3.943'),
    ];
    const fractions = await importRows(deps, fractionFile);
    expect(fractions.outcome).toMatchObject({ resolvedCorporateEvents: 2 });

    const institution = await deps.institutions.resolve('Corretora Teste');
    const klbn4 = replayPosition(
      await deps.transactions.listForPosition(
        await deps.assets.resolve({
          code: 'KLBN4',
          name: 'KLBN4',
          assetClass: 'stock',
          classStated: false,
          nameStated: false,
        }),
        institution,
      ),
    );
    expect(klbn4.ok && klbn4.value.quantity.toString()).toBe('2');
    expect(klbn4.ok && klbn4.value.totalCost.toString()).toBe('4.8');
    expect(klbn4.ok && klbn4.value.averageCost.toString()).toBe('2.4');
    expect(klbn4.ok && klbn4.value.realizedGain.toString()).toBe('0');

    const beforeReimport = deps.transactions.rows.length;
    const again = await importRows(deps, fractionFile);
    expect(again.outcome).toMatchObject({ applied: 0, resolvedCorporateEvents: 0 });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  /**
   * #129 review — the arrival order the owner's real ledger was in, which
   * neither earlier test covers. The `Fração em Ativos` and `Leilão de Fração`
   * rows were already stored `unclassified` by an import that ran before the
   * tracing existed, so they take the `duplicate` → `in_place` path, where
   * "activated in place, key kept, not a user edit" lives (BR-005-20).
   *
   * Same arithmetic as the chain above: KLBN11 106,6 at 1.066,00 leaves 0,6,
   * 6,00 moves out, KLBN4 receives 2,4 at 4,80, and the 0,4 fraction leaves 2
   * shares at 4,80.
   */
  it('#129: activates a traced fraction in place, keeping its key', async () => {
    const deps = buildFakeIngestionDeps('2026-09-19');
    const row = (
      b3Type: string,
      direction: 'credit' | 'debit',
      assetCode: string,
      tradeDate: string,
      quantity: string,
      unitPrice = '0',
    ): ParsedRecord =>
      buy({
        b3Type,
        direction,
        assetCode,
        assetName: assetCode,
        tradeDate: BusinessDate.of(tradeDate),
        quantity: Quantity.fromString(quantity),
        unitPrice: Money.fromString(unitPrice),
        fees: Money.zero(),
        priceStated: unitPrice !== '0',
      });

    // First import: the fractions arrive with no conversion to trace, so both
    // they and their auctions commit `unclassified` — the pre-fix ledger.
    const fractionsOnly = [
      row('Fração em Ativos', 'debit', 'KLBN4', '2026-01-22', '0.4'),
      row('Leilão de Fração', 'credit', 'KLBN4', '2026-02-24', '0.4', '3.943'),
    ];
    const stranded = await importRows(deps, fractionsOnly);
    expect(stranded.outcome).toMatchObject({ resolvedCorporateEvents: 0 });
    const storedIds = deps.transactions.rows.map((r) => [r.id, r.naturalKey, r.status]);
    expect(storedIds.every(([, , status]) => status === 'unclassified')).toBe(true);

    // Then the history that makes them traceable.
    await importRows(deps, [
      buy({
        assetCode: 'KLBN11',
        assetName: 'KLBN11',
        tradeDate: BusinessDate.of('2023-01-02'),
        quantity: Quantity.fromString('100'),
        unitPrice: Money.fromString('10.66'),
        fees: Money.zero(),
      }),
      row('Bonificação em Ativos', 'credit', 'KLBN11', '2025-12-19', '6.6'),
      row('Transferência', 'debit', 'KLBN11', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN3', '2025-12-23', '0.6'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '2'),
      row('Transferência', 'credit', 'KLBN4', '2025-12-23', '0.4'),
    ]);

    // Re-importing the fraction file now resolves both, in place.
    const resolved = await importRows(deps, fractionsOnly);
    expect(resolved.outcome).toMatchObject({ resolvedCorporateEvents: 2 });

    for (const [id, naturalKey] of storedIds) {
      const promoted = deps.transactions.rows.find((r) => r.id === id);
      expect(promoted).toMatchObject({
        naturalKey,
        status: 'active',
        isUserModified: false,
      });
    }
    expect(
      deps.transactions.rows
        .filter((r) => storedIds.some(([id]) => id === r.id))
        .map((r) => r.type)
        .sort(),
    ).toEqual(['fracao_bonificacao', 'leilao_fracoes']);

    const institution = await deps.institutions.resolve('Corretora Teste');
    const klbn4 = replayPosition(
      await deps.transactions.listForPosition(
        await deps.assets.resolve({
          code: 'KLBN4',
          name: 'KLBN4',
          assetClass: 'stock',
          classStated: false,
          nameStated: false,
        }),
        institution,
      ),
    );
    expect(klbn4.ok && klbn4.value.quantity.toString()).toBe('2');
    expect(klbn4.ok && klbn4.value.totalCost.toString()).toBe('4.8');

    const beforeReimport = deps.transactions.rows.length;
    const again = await importRows(deps, fractionsOnly);
    expect(again.outcome).toMatchObject({ applied: 0, resolvedCorporateEvents: 0 });
    expect(deps.transactions.rows).toHaveLength(beforeReimport);
  });

  it('keeps incomplete target evidence unclassified', async () => {
    const deps = buildFakeIngestionDeps();
    const result = await importRows(deps, [evidence('Atualização', 'AXIA3', '2025-02-03', '260')]);
    expect(result.outcome).toMatchObject({
      resolvedAssetConversions: 0,
      committedConversionLegs: 0,
    });
    expect(deps.transactions.rows).toHaveLength(1);
    expect(deps.transactions.rows[0]?.status).toBe('unclassified');
  });

  it('keeps complete evidence unclassified while the rollback-safety latch is disabled', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'ELET3',
        assetName: 'ELET3',
        tradeDate: BusinessDate.of('2025-01-02'),
        quantity: Quantity.fromString('260'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [evidence('Atualização', 'AXIA3', '2025-02-03', '260')],
    });
    const result = await commitBatch(deps, userId, {
      batchId,
      assetConversionsEnabled: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolvedAssetConversions).toBe(0);
    expect(deps.transactions.rows.at(-1)?.status).toBe('unclassified');
  });

  it('sees a same-day carried source before conversion but leaves an ordinary same-day buy after it', async () => {
    const deps = buildFakeIngestionDeps();
    await importRows(deps, [
      buy({
        assetCode: 'ELET3',
        assetName: 'ELET3',
        institutionName: 'Origem',
        tradeDate: BusinessDate.of('2025-01-02'),
        quantity: Quantity.fromString('260'),
        unitPrice: Money.fromString('10'),
        fees: Money.zero(),
      }),
    ]);
    const day = BusinessDate.of('2025-02-03');
    const result = await importRows(deps, [
      buy({
        b3Type: 'Transferência',
        direction: 'credit',
        assetCode: 'ELET3',
        assetName: 'ELET3',
        institutionName: 'Destino',
        tradeDate: day,
        quantity: Quantity.fromString('260'),
        unitPrice: Money.zero(),
        fees: Money.zero(),
        priceStated: false,
      }),
      buy({
        b3Type: 'Transferência',
        direction: 'debit',
        assetCode: 'ELET3',
        assetName: 'ELET3',
        institutionName: 'Origem',
        tradeDate: day,
        quantity: Quantity.fromString('260'),
        unitPrice: Money.zero(),
        fees: Money.zero(),
        priceStated: false,
      }),
      evidence('Atualização', 'AXIA3', '2025-02-03', '260', 'Destino'),
      buy({
        assetCode: 'ELET3',
        assetName: 'ELET3',
        institutionName: 'Destino',
        tradeDate: day,
        quantity: Quantity.fromString('10'),
        unitPrice: Money.fromString('20'),
        fees: Money.zero(),
      }),
    ]);

    expect(result.outcome).toMatchObject({
      resolvedAssetConversions: 1,
      committedConversionLegs: 2,
    });
    const incoming = deps.transactions.rows.find((row) => row.type === 'conversion_in');
    expect(incoming?.costBasis?.toString()).toBe('2600');
    const sourceId = await deps.assets.resolve({
      code: 'ELET3',
      name: 'ELET3',
      assetClass: 'stock',
      classStated: false,
      nameStated: false,
    });
    const destinationInstitution = await deps.institutions.resolve('Destino');
    const source = replayPosition(
      await deps.transactions.listForPosition(sourceId, destinationInstitution),
    );
    expect(source.ok && source.value.quantity.toString()).toBe('10');
    expect(source.ok && source.value.totalCost.toString()).toBe('200');
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
        conversionGroupId: null,
        costBasis: null,
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

  it('#121 ordering: a source-day buy funds transfer_out before the carry reaches a conversion', async () => {
    const deps = buildFakeIngestionDeps();
    await importFile(deps, [history()]);

    await importFile(deps, [
      // BR-005-20a: the source-day buy participates in the outgoing carried cost.
      history({ tradeDate: TRANSFER_DAY, unitPrice: Money.fromString('20') }),
      credit(),
      debit(),
    ]);

    expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('15');
    // 100 @ 10,00 plus 100 @ 20,00 is averaged before 100 leaves at 15,00.
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

  /**
   * #135 — B3 recorded the July 2023 Energias do Brasil buyout as a price-less
   * `Transferência` debit *and* credit at one broker. Requiring a different
   * institution formed no pair: the credit stayed `unclassified` while the
   * debit, needing no price, applied. The position went to zero and the shares
   * left *patrimônio* with nothing recording their return.
   */
  describe('#135 — a same-institution pair moves nothing', () => {
    const ownCredit = (overrides: Partial<NormalizedTransactionRecord> = {}) =>
      credit({ institutionName: ORIGEM, ...overrides });

    it('leaves quantity, average and total cost exactly as they were', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      const before = await positionAt(deps, ORIGEM);
      expect(before).toEqual({ quantity: '100', averageCost: '10', totalCost: '1000' });

      const { outcome } = await importFile(deps, [ownCredit(), debit()]);

      expect(outcome.applied).toBe(2);
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'active' });
      expect(transfersIn(deps)[0]?.unitPrice.toString()).toBe('10');
      expect(await positionAt(deps, ORIGEM)).toEqual(before);
      expect(outcome.batch.rowCounts).toMatchObject({ needsAttention: 0 });
      await expectRebuildEqualsIncremental(deps);
    });

    it('a later sale of the whole position applies against the restored shares', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await importFile(deps, [ownCredit(), debit()]);

      const { outcome } = await importFile(deps, [
        buy({
          b3Type: 'Venda',
          direction: null,
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2026-03-11'),
          unitPrice: Money.fromString('12'),
          fees: Money.zero(),
        }),
      ]);

      expect(outcome).toMatchObject({ applied: 1, invalid: 0 });
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '0',
        averageCost: '0',
        totalCost: '0',
      });
    });

    it('BR-005-17: re-importing the pair adds nothing', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await importFile(deps, [ownCredit(), debit()]);
      const inserts = deps.transactions.insertCount;

      const again = await importFile(deps, [ownCredit(), debit()]);

      expect(again.outcome).toMatchObject({ applied: 0, promoted: 0, skippedDuplicates: 2 });
      expect(deps.transactions.insertCount).toBe(inserts);
      await expectRebuildEqualsIncremental(deps);
    });

    /**
     * The owner's state: #110's rule left the debit active and the credit
     * `unclassified` at its placeholder zero. Re-importing the same file
     * promotes the credit in place and the position comes back.
     */
    it('promotes the credit an earlier import left unclassified, restoring the position', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history()]);
      await commitAsIssue108(deps, [ownCredit(), debit()]);
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '0',
        averageCost: '0',
        totalCost: '0',
      });

      const again = await importFile(deps, [ownCredit(), debit()]);

      expect(again.outcome).toMatchObject({ applied: 0, promoted: 1 });
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '100',
        averageCost: '10',
        totalCost: '1000',
      });
      await expectRebuildEqualsIncremental(deps);
    });

    /**
     * BR-005-20a's guard, on a position the debit would replay against
     * perfectly well: 100 shares held at no cost (BR-007-05), so the carry
     * resolves nothing. Without the guard the debit applies alone and the 100
     * shares are gone. Nothing is written for it, no occurrence is taken, and
     * the file imports once the position has a cost to carry (BR-005-17).
     */
    it('refuses the debit rather than emptying the position when the carry cannot resolve', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [
        buy({
          b3Type: 'Bonificação em Ativos',
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2026-01-05'),
          priceStated: false,
          unitPrice: Money.zero(),
          fees: Money.zero(),
        }),
      ]);
      const before = await positionAt(deps, ORIGEM);
      expect(before).toEqual({ quantity: '100', averageCost: '0', totalCost: '0' });

      const { batchId, outcome } = await importFile(deps, [ownCredit(), debit()]);

      // The credit is stored `unclassified` as BR-005-19 requires; the debit
      // is the one row this commit refuses.
      expect(outcome).toMatchObject({ applied: 1, invalid: 1 });
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
      const rows = await deps.rows.listByBatch(batchId);
      expect(rows.map((row) => [row.ledgerType, row.classification])).toEqual([
        ['transfer_in', 'unclassified'],
        ['transfer_out', 'invalid'],
      ]);
      expect(deps.transactions.rows.some((t) => t.type === 'transfer_out')).toBe(false);
      expect(await positionAt(deps, ORIGEM)).toEqual(before);
    });

    it('applies both legs once the history behind them is imported', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [ownCredit(), debit()]);
      await importFile(deps, [history()]);

      const again = await importFile(deps, [ownCredit(), debit()]);

      expect(again.outcome).toMatchObject({ applied: 1, promoted: 1, invalid: 0 });
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '100',
        averageCost: '10',
        totalCost: '1000',
      });
      await expectRebuildEqualsIncremental(deps);
    });

    /**
     * Review finding 1A. Two same-position pairs of one quantity on one date:
     * each credit sees two candidate debits, so `pairTransfers` forms nothing
     * and a guard asked of formed pairs alone let both debits through. The
     * position went to zero with neither credit carrying anything.
     */
    it('holds back both debits where two same-position pairs of one quantity compete', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [history({ quantity: Quantity.fromString('200') })]);
      const before = await positionAt(deps, ORIGEM);
      expect(before).toEqual({ quantity: '200', averageCost: '10', totalCost: '2000' });

      const { outcome } = await importFile(deps, [ownCredit(), ownCredit(), debit(), debit()]);

      expect(outcome).toMatchObject({ applied: 2, invalid: 2 });
      expect(deps.transactions.rows.some((t) => t.type === 'transfer_out')).toBe(false);
      expect(transfersIn(deps).map((t) => t.status)).toEqual(['unclassified', 'unclassified']);
      expect(await positionAt(deps, ORIGEM)).toEqual(before);
    });

    /**
     * Review finding 1B. A same-institution debit competing with a
     * cross-institution one. The credit pairs with neither — two candidate
     * sources is exactly what the ambiguity guard refuses to choose between —
     * but the debit at the credit's own position must still be held back,
     * while the one at the other broker applies as it always has.
     */
    it('holds back only the same-position debit when a cross-institution one competes', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [
        history(),
        history({ institutionName: DESTINO, unitPrice: Money.fromString('20') }),
      ]);

      const { outcome } = await importFile(deps, [
        ownCredit(),
        debit(),
        debit({ institutionName: DESTINO }),
      ]);

      expect(outcome).toMatchObject({ applied: 2, invalid: 1 });
      // ORIGEM keeps its 100: the debit that would have emptied it is refused.
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '100',
        averageCost: '10',
        totalCost: '1000',
      });
      // DESTINO's own debit is written, as a cross-broker debit always is.
      expect(await positionAt(deps, DESTINO)).toEqual({
        quantity: '0',
        averageCost: '0',
        totalCost: '0',
      });
      expect(transfersIn(deps).map((t) => t.status)).toEqual(['unclassified']);
      await expectRebuildEqualsIncremental(deps);
    });

    /**
     * Review finding 2. The hold-back runs **before** the exclusion ladder: a
     * round that gave up a sale because the position had been emptied by a
     * debit this rule was going to hold back never reconsiders it — exclusions
     * only grow — so the sale was refused on that import and every one after,
     * while the batch page called it `applicable`.
     */
    it('does not cost another row on the same position its place in the ledger', async () => {
      const deps = buildFakeIngestionDeps();
      await importFile(deps, [
        buy({
          b3Type: 'Bonificação em Ativos',
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2026-01-05'),
          priceStated: false,
          unitPrice: Money.zero(),
          fees: Money.zero(),
        }),
      ]);

      const { outcome } = await importFile(deps, [
        ownCredit(),
        debit(),
        buy({
          b3Type: 'Venda',
          direction: null,
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2026-03-11'),
          unitPrice: Money.fromString('12'),
          fees: Money.zero(),
        }),
      ]);

      // The credit stored unclassified and the sale applied; only the debit is refused.
      expect(outcome).toMatchObject({ applied: 2, invalid: 1 });
      expect(deps.transactions.rows.some((t) => t.type === 'sell')).toBe(true);
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '0',
        averageCost: '0',
        totalCost: '0',
      });
      await expectRebuildEqualsIncremental(deps);
    });

    /**
     * A cross-institution debit is the whole record of shares genuinely
     * leaving that broker, and BR-005-20a has always let its credit wait for
     * history that has not been imported. Holding it back too would refuse
     * every ordinary transfer imported ahead of its source.
     */
    it('still applies a cross-institution debit whose credit cannot be carried', async () => {
      const deps = buildFakeIngestionDeps();
      // The same zero-cost source: the carry resolves nothing here either.
      await importFile(deps, [
        buy({
          b3Type: 'Bonificação em Ativos',
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2026-01-05'),
          priceStated: false,
          unitPrice: Money.zero(),
          fees: Money.zero(),
        }),
      ]);

      const { outcome } = await importFile(deps, [credit(), debit()]);

      expect(outcome).toMatchObject({ applied: 2, invalid: 0 });
      expect(await positionAt(deps, ORIGEM)).toEqual({
        quantity: '0',
        averageCost: '0',
        totalCost: '0',
      });
      // BR-005-19: the shares are visible at the destination, waiting for a cost.
      expect(transfersIn(deps)[0]).toMatchObject({ status: 'unclassified' });
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
        conversionGroupId: null,
        costBasis: null,
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

  it('leaves a consumed auction unresolved when its pre-existing ledger cannot replay', async () => {
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(grndFactor());

    // This reproduces the owner's pre-#113 ledger shape: the fraction was
    // already classified, while its later auction was still absent.
    const first = await importFile(deps, grnd().slice(0, 3));
    const storedFraction = await transactionOf(deps, first.batchId, 'Fração em Ativos');
    await deps.transactions.update({
      ...storedFraction,
      type: 'sell',
      status: 'active',
      unitPrice: Money.fromString('98'),
      totalValue: Money.fromString('49'),
    });

    // Only reachable by editing around the write guard: a later stored sale
    // makes this old ledger fail independently of the auction being consumed.
    const holding = deps.transactions.rows.find((transaction) => transaction.type === 'buy');
    if (holding === undefined) throw new Error('missing fixture holding');
    await deps.transactions.insert({
      ...holding,
      id: TransactionId.generate(),
      naturalKey: 'fixture|stored-overdraw',
      occurrence: 1,
      type: 'sell',
      tradeDate: BusinessDate.of('2024-07-01'),
      quantity: Quantity.fromString('100'),
      unitPrice: Money.fromString('1'),
      totalValue: Money.fromString('100'),
      importBatchId: null,
      isManual: true,
    });

    const again = await importFile(deps, grnd());

    expect(again.outcome).toMatchObject({ resolvedCorporateEvents: 0, consumedAuctions: 0 });
    expect(await transactionOf(deps, again.batchId, 'Leilão de Fração')).toMatchObject({
      type: UNCLASSIFIED_PLACEHOLDER_TYPE,
      status: 'unclassified',
    });
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

  it('a transfer after a Desdobro carries the post-event average cost', async () => {
    // Origem: 70 @ 100,00 becomes 700 @ 10,00 after the Desdobro. The later
    // transfer of 50 must therefore carry 500,00 (10,00 each), not the
    // pre-event 100,00 average cost.
    const deps = buildFakeIngestionDeps();
    deps.corporateEventFactors.seed(alzrFactor());
    const at = (record: ParsedRecord, institutionName: string): ParsedRecord => ({
      ...record,
      record: { ...(record.record as NormalizedTransactionRecord), institutionName },
    });

    const { outcome } = await importFile(deps, [
      at(compra('ALZR11', '2024-01-10', '70', '100'), 'Corretora Origem'),
      at(desdobro('ALZR11', '2024-03-05', '630'), 'Corretora Origem'),
      at(movement('Transferência', 'debit', 'ALZR11', '2024-04-01', '50'), 'Corretora Origem'),
      at(movement('Transferência', 'credit', 'ALZR11', '2024-04-01', '50'), 'Corretora Destino'),
    ]);

    expect(outcome).toMatchObject({ resolvedCorporateEvents: 1 });
    const carried = deps.transactions.rows.find(
      (transaction) => transaction.type === 'transfer_in' && transaction.status === 'active',
    );
    expect(carried?.unitPrice.toString()).toBe('10');
    expect(carried?.totalValue.toString()).toBe('500');

    const origem = await deps.institutions.resolve('Corretora Origem');
    const destino = await deps.institutions.resolve('Corretora Destino');
    const positions = await deps.positions.list();
    expect(positions.find((position) => position.institutionId === origem)?.state).toMatchObject({
      quantity: Quantity.fromString('650'),
      totalCost: Money.fromString('6500'),
    });
    expect(positions.find((position) => position.institutionId === destino)?.state).toMatchObject({
      quantity: Quantity.fromString('50'),
      totalCost: Money.fromString('500'),
    });
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

describe('#138 — the four Movimentação rows that refused on every import', () => {
  const CLEAR = 'Clear';
  const XP = 'XP';
  const INTER = 'Inter';

  async function importFile(
    deps: FakeIngestionDeps,
    records: readonly ParsedRecord[],
    assetConversionsEnabled = true,
  ) {
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records });
    const result = await commitBatch(deps, userId, { batchId, assetConversionsEnabled });
    if (!result.ok) throw new Error(`commit failed: ${result.error.code}`);
    return { batchId, outcome: result.value };
  }

  async function positionOf(deps: FakeIngestionDeps, code: string, institution: string) {
    const assetId = await deps.assets.resolve({
      code,
      name: code,
      assetClass: 'stock',
      classStated: false,
      nameStated: false,
    });
    const institutionId = await deps.institutions.resolve(institution);
    const replayed = replayPosition(
      await deps.transactions.listForPosition(assetId, institutionId),
    );
    if (!replayed.ok) throw new Error(`${code} at ${institution} does not replay`);
    return replayed.value;
  }

  describe('BIDI11 → INBR32 (SPEC-005 BR-005-20c, SPEC-007 BR-007-05b)', () => {
    const inbr32 = (
      b3Type: string,
      direction: 'credit' | 'debit',
      institutionName: string,
      date: string,
    ) =>
      buy({
        b3Type,
        direction,
        assetCode: 'INBR32',
        assetName: 'INTER CO INC',
        assetClass: 'bdr',
        institutionName,
        tradeDate: BusinessDate.of(date),
        quantity: Quantity.fromString('1'),
        unitPrice: Money.zero(),
        fees: Money.zero(),
        priceStated: false,
      });
    /**
     * 3 BIDI11 for 10,00 at Clear, 1 sold: 2 units at 10 ÷ 3 each, a total
     * that repeats past the column's scale — 6,666…667 in replay, 6,66666667
     * stored. B3 converts two units into one INBR32 (the 2022 migration's
     * 2 : 1), then walks it Clear → XP → Inter by custody transfer.
     */
    const bidi11History = () => [
      buy({
        assetCode: 'BIDI11',
        assetName: 'BANCO INTER',
        institutionName: CLEAR,
        tradeDate: BusinessDate.of('2022-01-10'),
        quantity: Quantity.fromString('3'),
        unitPrice: Money.fromString('3.33333333'),
        fees: Money.fromString('0.00000001'),
      }),
      buy({
        b3Type: 'Venda',
        assetCode: 'BIDI11',
        assetName: 'BANCO INTER',
        institutionName: CLEAR,
        tradeDate: BusinessDate.of('2022-02-10'),
        quantity: Quantity.fromString('1'),
        unitPrice: Money.fromString('4'),
        fees: Money.zero(),
      }),
    ];
    const migration = () => [
      inbr32('Atualização', 'credit', CLEAR, '2022-08-30'),
      inbr32('Transferência', 'debit', CLEAR, '2023-11-14'),
      inbr32('Transferência', 'credit', XP, '2023-11-14'),
      inbr32('Transferência', 'debit', XP, '2024-02-02'),
      inbr32('Transferência', 'credit', INTER, '2024-02-02'),
      buy({
        b3Type: 'Dividendo',
        direction: 'credit',
        assetCode: 'INBR32',
        assetName: 'INTER CO INC',
        assetClass: 'bdr',
        institutionName: INTER,
        tradeDate: BusinessDate.of('2024-05-06'),
        quantity: Quantity.fromString('1'),
        unitPrice: Money.fromString('0.153'),
        fees: Money.zero(),
      }),
    ];

    it('resolves the group a pre-v5 commit left unclassified, and both custody transfers carry its cost', async () => {
      const deps = buildFakeIngestionDeps();
      const file = [...bidi11History(), ...migration()];
      // The owner's state: committed before the definition could resolve, so
      // the Atualização and both credits are unclassified and both debits
      // were refused for want of a position.
      const before = await importFile(deps, file, false);
      expect(before.outcome).toMatchObject({ invalid: 2, resolvedAssetConversions: 0 });

      const again = await importFile(deps, file);

      expect(again.outcome).toMatchObject({
        invalid: 0,
        resolvedAssetConversions: 1,
        committedConversionLegs: 2,
        promoted: 2,
      });
      const legs = deps.transactions.rows.filter((row) => row.conversionGroupId !== null);
      // The persisted leg is the replayed total at the column's scale.
      expect(legs.map((row) => row.costBasis?.toString())).toEqual(['6.66666667', '6.66666667']);
      const source = await positionOf(deps, 'BIDI11', CLEAR);
      expect(source.quantity.toString()).toBe('0');
      expect(source.totalCost.toString()).toBe('0');
      for (const institution of [CLEAR, XP]) {
        expect((await positionOf(deps, 'INBR32', institution)).quantity.toString()).toBe('0');
      }
      const held = await positionOf(deps, 'INBR32', INTER);
      expect(held.quantity.toString()).toBe('1');
      expect(held.totalCost.toString()).toBe('6.66666667');

      const count = deps.transactions.rows.length;
      const third = await importFile(deps, file);
      expect(third.outcome).toMatchObject({ applied: 0, invalid: 0, resolvedAssetConversions: 0 });
      expect(deps.transactions.rows).toHaveLength(count);
    });

    it('with no BIDI11 behind it, the Atualização stays unclassified and both debits are refused', async () => {
      const deps = buildFakeIngestionDeps();

      const { outcome } = await importFile(deps, migration());

      expect(outcome).toMatchObject({ invalid: 2, resolvedAssetConversions: 0 });
      expect(deps.transactions.rows.some((row) => row.conversionGroupId !== null)).toBe(false);
      expect((await positionOf(deps, 'INBR32', INTER)).quantity.toString()).toBe('0');
    });
  });

  describe('a Tesouro sale whose purchase predates the extract (SPEC-005 BR-005-19/24)', () => {
    const selic = (overrides: Partial<NormalizedTransactionRecord>) =>
      buy({
        assetCode: 'Tesouro Selic 2025',
        assetName: 'Tesouro Selic 2025',
        assetClass: 'tesouro_direto',
        institutionName: CLEAR,
        fees: Money.zero(),
        ...overrides,
      });
    // B3's semiannual custody fee: quantity 0, a charge, no price. It is the
    // only trace of a title bought before the extract's first date.
    const fee = selic({
      b3Type: 'Cobrança de Taxa Semestral',
      direction: 'debit',
      tradeDate: BusinessDate.of('2020-01-01'),
      quantity: Quantity.zero(),
      unitPrice: Money.zero(),
      priceStated: false,
    });
    const sale = selic({
      b3Type: 'Venda',
      direction: 'debit',
      tradeDate: BusinessDate.of('2020-03-18'),
      quantity: Quantity.fromString('1.05'),
      unitPrice: Money.fromString('10541.8'),
    });

    it('refuses the sale for missing history — never invents the purchase — and applies it once an opening position exists', async () => {
      const deps = buildFakeIngestionDeps();
      const first = await importFile(deps, [fee, sale]);

      expect(first.outcome).toMatchObject({ invalid: 1 });
      const rows = await deps.rows.listByBatch(first.batchId);
      const refused = rows.find((row) => row.classification === 'invalid');
      if (refused === undefined) throw new Error('the sale was not refused');
      const ledger = await deps.transactions.listForPosition(
        refused.assetId,
        refused.institutionId,
      );
      // The fee is unclassified but moves nothing, so the cause is the
      // history before the extract, not the fee.
      expect(
        explainRefusal(refused, ledger, userId, new Date(), BusinessDate.of('2026-03-15')),
      ).toMatchObject({ kind: 'insufficient_quantity', likelyCause: 'missing_history' });

      // The owner enters the opening position by hand (an Ajuste).
      await deps.transactions.insert({
        id: TransactionId.generate(),
        userId,
        assetId: refused.assetId,
        institutionId: refused.institutionId,
        type: 'adjustment',
        status: 'active',
        tradeDate: BusinessDate.of('2019-11-05'),
        quantity: Quantity.fromString('1.05'),
        unitPrice: Money.fromString('10000'),
        fees: Money.zero(),
        totalValue: Money.fromString('10500'),
        ratio: null,
        conversionGroupId: null,
        costBasis: null,
        naturalKey: 'manual|opening|selic-2025',
        occurrence: 1,
        importBatchId: null,
        isManual: true,
        isUserModified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const again = await importFile(deps, [fee, sale]);

      expect(again.outcome).toMatchObject({ applied: 1, invalid: 0 });
      const position = await positionOf(deps, 'Tesouro Selic 2025', CLEAR);
      expect(position.quantity.toString()).toBe('0');
      // 1,05 × 10.541,80 = 11.068,89; − 10.500,00 opening cost = 568,89.
      expect(position.realizedGain.toString()).toBe('568.89');
    });
  });
});
