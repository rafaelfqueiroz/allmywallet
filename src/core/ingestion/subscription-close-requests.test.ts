import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import type { ImportRow, NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import { buildFakeIngestionDeps } from '@/core/ingestion/test-support/build-deps';
import { planSubscriptionCloseRequests } from './subscription-close-requests';

/**
 * SPEC-005 BR-005-20d (#144 review F1) — the pre-commit preview
 * `backfillSubscriptionClosesForBatch` uses to decide which closes to fetch.
 * Must find a pair split across two imports and a re-import of an already-
 * staged, still-unresolved pair — not only a pair staged fresh in one batch.
 */
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

function subscriptionExercise(overrides: Partial<NormalizedTransactionRecord> = {}) {
  return buy({
    b3Type: 'Direitos de Subscrição - Exercido',
    priceStated: false,
    unitPrice: Money.zero(),
    fees: Money.zero(),
    ...overrides,
  });
}

function atualizacaoCredit(overrides: Partial<NormalizedTransactionRecord> = {}) {
  return buy({
    b3Type: 'Atualização',
    priceStated: false,
    unitPrice: Money.zero(),
    fees: Money.zero(),
    ...overrides,
  });
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

const WINDOW_DAYS = 120;

describe('planSubscriptionCloseRequests (SPEC-005 BR-005-20d, #144 review F1)', () => {
  it('finds a pair staged fresh in one batch', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    });
    const rows = await deps.rows.listByBatch(batchId);

    const requests = await planSubscriptionCloseRequests(deps, rows, WINDOW_DAYS);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ assetCode: 'XXXX11', upTo: '2024-02-22' });
  });

  it('F1 — finds a pair split across two imports: the exercise already committed, only the credit staged now', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const firstBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('9'),
          tradeDate: BusinessDate.of('2024-01-18'),
        }),
      ],
    });
    const first = await commitBatch(deps, userId, { batchId: firstBatch });
    expect(first.ok).toBe(true);

    const secondBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('9'),
          tradeDate: BusinessDate.of('2024-02-26'),
        }),
      ],
    });
    const secondRows = await deps.rows.listByBatch(secondBatch);

    const requests = await planSubscriptionCloseRequests(deps, secondRows, WINDOW_DAYS);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ assetCode: 'XXXX11', upTo: '2024-02-26' });
  });

  it('F1 — finds a re-import of an already-staged, still-unresolved pair (both rows now duplicate)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    };
    // No close ever seeded — the first commit leaves both rows unclassified.
    const firstBatch = await stagedBatch(deps, extract);
    const first = await commitBatch(deps, userId, { batchId: firstBatch });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.resolvedSubscriptions).toBe(0);

    // Re-import of the identical file: both rows now stage `duplicate`.
    const secondBatch = await stagedBatch(deps, extract);
    const secondRows = await deps.rows.listByBatch(secondBatch);
    expect(secondRows.every((row) => row.classification === 'duplicate')).toBe(true);

    const requests = await planSubscriptionCloseRequests(deps, secondRows, WINDOW_DAYS);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ assetCode: 'XXXX11', upTo: '2024-02-22' });
  });

  it('requests nothing once a pair is already applied (no re-fetch, D7)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    };
    const firstBatch = await stagedBatch(deps, extract);
    const rowsBeforeClose = await deps.rows.listByBatch(firstBatch);
    const creditRow = rowsBeforeClose.find(
      (row) => row.record.kind === 'transaction' && row.record.assetCode === 'XXXX11',
    ) as ImportRow;
    deps.closePrices.seed(
      creditRow.assetId,
      BusinessDate.of('2024-02-22'),
      Money.fromString('114.90'),
    );
    const first = await commitBatch(deps, userId, { batchId: firstBatch });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.resolvedSubscriptions).toBe(1);

    const secondBatch = await stagedBatch(deps, extract);
    const secondRows = await deps.rows.listByBatch(secondBatch);

    const requests = await planSubscriptionCloseRequests(deps, secondRows, WINDOW_DAYS);

    expect(requests).toHaveLength(0);
  });

  it('requests nothing once the exercise row has been classified by hand as something else', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
      ],
    });
    const rows = await deps.rows.listByBatch(batchId);
    const exerciseRow = rows.find((row) => row.record.kind === 'transaction') as ImportRow;
    // Commit first so the exercise row has a stored transaction to reclassify.
    const committed = await commitBatch(deps, userId, { batchId });
    expect(committed.ok).toBe(true);
    const classified = await classifyImportRow(deps, {
      rowId: exerciseRow.id,
      type: 'bonificacao',
    });
    expect(classified.ok).toBe(true);

    const secondBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    });
    const secondRows = await deps.rows.listByBatch(secondBatch);

    const requests = await planSubscriptionCloseRequests(deps, secondRows, WINDOW_DAYS);

    expect(requests).toHaveLength(0);
  });

  it('requests nothing when no exercise or credit row is present', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, { extractType: 'b3_movimentacao', records: [buy()] });
    const rows = await deps.rows.listByBatch(batchId);

    const requests = await planSubscriptionCloseRequests(deps, rows, WINDOW_DAYS);

    expect(requests).toHaveLength(0);
  });

  it('requests nothing for a quantity mismatch (ambiguous/no match)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('3'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('46'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    });
    const rows = await deps.rows.listByBatch(batchId);

    const requests = await planSubscriptionCloseRequests(deps, rows, WINDOW_DAYS);

    expect(requests).toHaveLength(0);
  });
});
