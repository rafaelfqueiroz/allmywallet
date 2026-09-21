import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { aTransaction } from '@/core/ledger/test-support/transaction-builder';
import type {
  NormalizedPositionRecord,
  NormalizedTransactionRecord,
  ParsedExtract,
} from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import {
  acceptReconciliationAdjustment,
  adjustmentBlocker,
} from '@/core/ingestion/accept-adjustment';
import type { Discrepancy } from '@/core/ingestion/reconcile';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();
const AS_OF = BusinessDate.of('2026-03-01');

async function stageAndCommit(
  deps: FakeIngestionDeps,
  extract: ParsedExtract,
  asOf?: BusinessDate,
): Promise<ImportBatchId> {
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
  await stageBatch(deps, userId, { batchId, extract });
  const committed = await commitBatch(
    deps,
    userId,
    asOf === undefined ? { batchId } : { batchId, asOf },
  );
  if (!committed.ok) throw new Error('commit failed in test setup');
  return batchId;
}

/** B3's Posição: 50 HGLG11, no institution, as of 2026-03-01. */
async function commitPosicao(deps: FakeIngestionDeps): Promise<ImportBatchId> {
  const record: NormalizedPositionRecord = {
    kind: 'position',
    assetCode: 'HGLG11',
    assetName: 'CSHG Logística',
    assetClass: 'fii',
    institutionName: null,
    quantity: Quantity.fromString('50'),
    fixedIncome: null,
  };
  return stageAndCommit(
    deps,
    { extractType: 'b3_posicao', records: [{ raw: { Produto: 'HGLG11' }, record }] },
    AS_OF,
  );
}

/** The ledger's own history: a purchase of HGLG11 at 10,00 with no fees. */
async function commitPurchase(deps: FakeIngestionDeps, quantity: string, tradeDate: string) {
  const record: NormalizedTransactionRecord = {
    kind: 'transaction',
    b3Type: 'Compra',
    direction: null,
    assetCode: 'HGLG11',
    assetName: 'CSHG Logística',
    assetClass: 'fii',
    institutionName: null,
    tradeDate: BusinessDate.of(tradeDate),
    quantity: Quantity.fromString(quantity),
    unitPrice: Money.fromString('10'),
    priceStated: true,
    fees: Money.zero(),
    ratio: null,
  };
  await stageAndCommit(deps, {
    extractType: 'b3_negociacao',
    records: [{ raw: { Codigo: 'HGLG11' }, record }],
  });
}

const hglg11 = (deps: FakeIngestionDeps) =>
  deps.assets.resolve({
    code: 'HGLG11',
    name: 'CSHG Logística',
    assetClass: 'fii',
    classStated: true,
    nameStated: true,
  });

describe('SPEC-005 BR-005-25 — acceptReconciliationAdjustment', () => {
  it('creates a dated adjustment for the difference against existing history, never editing it', async () => {
    const deps = buildFakeIngestionDeps();
    // 30 bought at 10,00 on 01/02; B3 reports 50 on 01/03 → difference +20.
    await commitPurchase(deps, '30', '2026-02-01');
    const batchId = await commitPosicao(deps);
    const inserts = deps.transactions.insertCount;

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await hglg11(deps),
      institutionId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.transaction.type).toBe('adjustment');
    expect(result.value.result.transaction.quantity.toString()).toBe('20');
    // At the position's average, 300,00 ÷ 30 = 10,00.
    expect(result.value.result.transaction.unitPrice.toString()).toBe('10');
    expect(result.value.result.transaction.tradeDate).toBe('2026-03-01');
    expect(deps.transactions.insertCount).toBe(inserts + 1);
    expect(result.value.batch.reconciliation?.discrepancies[0]?.resolved).toBe(true);
    // 30 + 20 = 50, B3's figure; the purchase itself is untouched.
    expect(result.value.result.recalculation.position?.state.quantity.toString()).toBe('50');
    expect(deps.transactions.rows.filter((t) => t.type === 'buy')).toHaveLength(1);
  });

  it('#110: refuses a position with no history at all, writing nothing', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await commitPosicao(deps);
    const inserts = deps.transactions.insertCount;

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await hglg11(deps),
      institutionId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ADJUSTMENT_NO_HISTORY');
    expect(deps.transactions.insertCount).toBe(inserts);
    expect(deps.transactions.rows).toHaveLength(0);
    const batch = await deps.batches.findById(batchId);
    expect(batch?.reconciliation?.discrepancies[0]?.resolved).toBe(false);
  });

  it('#110: refuses when the only history is after the reconciliation date', async () => {
    const deps = buildFakeIngestionDeps();
    const batchId = await commitPosicao(deps);
    await commitPurchase(deps, '50', '2026-03-05');

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await hglg11(deps),
      institutionId: null,
    });

    expect(result.ok || result.error.code).toBe('IMPORT_ADJUSTMENT_NO_HISTORY');
    expect(deps.transactions.rows.filter((t) => t.type === 'adjustment')).toHaveLength(0);
  });

  it('#110: refuses a report made stale by history imported after it, writing nothing', async () => {
    const deps = buildFakeIngestionDeps();
    // The owner's order: Posição into an empty ledger (computed 0, difference
    // +50), then the 50 bought on 01/02 imported afterwards.
    const batchId = await commitPosicao(deps);
    await commitPurchase(deps, '50', '2026-02-01');
    const inserts = deps.transactions.insertCount;

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await hglg11(deps),
      institutionId: null,
    });

    // Accepting the stored +50 would make 100 — the doubling.
    expect(result.ok || result.error.code).toBe('IMPORT_ADJUSTMENT_STALE');
    expect(deps.transactions.insertCount).toBe(inserts);
    const batch = await deps.batches.findById(batchId);
    expect(batch?.reconciliation?.discrepancies[0]?.resolved).toBe(false);
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
        asOf: AS_OF,
        discrepancies: [],
        status: 'reconciled',
      },
      failureCode: null,
    });

    const result = await acceptReconciliationAdjustment(deps, userId, {
      batchId,
      assetId: await deps.assets.resolve({
        code: 'X',
        name: 'X',
        assetClass: 'stock',
        classStated: true,
        nameStated: true,
      }),
      institutionId: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('#110 BR-005-25 — adjustmentBlocker', () => {
  const discrepancy = (computedQuantity: string): Discrepancy =>
    ({ computedQuantity }) as unknown as Discrepancy;

  it('is no_history when nothing active is on or before the date — an unclassified row counts for nothing', () => {
    const unclassified = aTransaction().buy().on('2026-02-01').status('unclassified').build();
    expect(adjustmentBlocker(discrepancy('0'), [unclassified], AS_OF)).toBe('no_history');
  });

  it('is null when the ledger still holds what the report computed', () => {
    const buy = aTransaction().buy().on('2026-03-01').quantity('30').build();
    expect(adjustmentBlocker(discrepancy('30'), [buy], AS_OF)).toBeNull();
  });

  it('review 5: is null for a position traded after the date — the report counted the whole ledger', () => {
    // 30 before the date and 10 after: the report computed 40, as the ledger still holds.
    const before = aTransaction().buy().on('2026-02-01').quantity('30').build();
    const after = aTransaction().buy().on('2026-03-05').quantity('10').build();
    expect(adjustmentBlocker(discrepancy('40'), [before, after], AS_OF)).toBeNull();
  });

  it('is stale when the ledger now holds another quantity', () => {
    const buy = aTransaction().buy().on('2026-02-01').quantity('30').build();
    expect(adjustmentBlocker(discrepancy('0'), [buy], AS_OF)).toBe('stale');
  });

  it('#145: is absent_from_snapshot for a position B3 does not list, whatever the ledger holds', () => {
    const buy = aTransaction().buy().on('2026-02-01').quantity('180').build();
    const absent = {
      computedQuantity: '180',
      cause: 'absent_from_b3_snapshot',
    } as unknown as Discrepancy;
    expect(adjustmentBlocker(absent, [buy], AS_OF)).toBe('absent_from_snapshot');
  });

  it('is stale when the ledger no longer replays', () => {
    const oversold = aTransaction().sell().on('2026-02-01').quantity('10').build();
    expect(adjustmentBlocker(discrepancy('0'), [oversold], AS_OF)).toBe('stale');
  });
});
