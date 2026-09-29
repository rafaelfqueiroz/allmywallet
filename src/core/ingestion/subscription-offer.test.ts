import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, ImportRowId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity, asStored } from '@/core/shared/money';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { computeTotalValue, type Transaction } from '@/core/ledger/transaction';
import { replayPosition } from '@/core/positions/replay';
import { PositionErrorCode } from '@/core/positions/errors';
import { IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import type { ImportRow, NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';
import {
  findSubscriptionOffers,
  keepSubscriptionClassification,
  resolveSubscriptionOffer,
} from '@/core/ingestion/subscription-offer';

/**
 * SPEC-005 BR-005-20d (#157, DL-005-25) — the two actions a hand-classified,
 * zero-cost subscription credit offers its exercise: **Resolve as
 * subscription** and **Keep my classification**. Generated fixtures only
 * (DV-24) — the shape is the owner's real HGLG12/HGLG11 case, values invented.
 */

const userId = UserId.generate();
const WINDOW_DAYS = 120;

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

/** SPEC-005 BR-005-18 v6 — a `Direitos de Subscrição - Exercido` debit: the right ticker, no price. */
function subscriptionExercise(overrides: Partial<NormalizedTransactionRecord> = {}) {
  return buy({
    b3Type: 'Direitos de Subscrição - Exercido',
    priceStated: false,
    unitPrice: Money.zero(),
    fees: Money.zero(),
    ...overrides,
  });
}

/** SPEC-005 BR-005-18 v5 — a price-less `Atualização` credit: the main asset, no price. */
function atualizacaoCredit(overrides: Partial<NormalizedTransactionRecord> = {}) {
  return buy({
    b3Type: 'Atualização',
    priceStated: false,
    unitPrice: Money.zero(),
    fees: Money.zero(),
    ...overrides,
  });
}

function transferLeg(
  direction: 'credit' | 'debit',
  overrides: Partial<NormalizedTransactionRecord> = {},
) {
  return buy({
    b3Type: 'Transferência',
    direction,
    priceStated: false,
    unitPrice: Money.zero(),
    fees: Money.zero(),
    ...overrides,
  });
}

async function stagedBatch(deps: FakeIngestionDeps, extract: ParsedExtract) {
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

function findRow(rows: readonly ImportRow[], code: string): ImportRow {
  const row = rows.find((r) => r.record.kind === 'transaction' && r.record.assetCode === code);
  if (row === undefined) throw new Error(`no staged row for ${code}`);
  return row;
}

/** A committed exercise/credit pair, the credit hand-classified as a zero-cost bonificação — DL-005-25's real shape. */
async function setupOfferedPair(deps: FakeIngestionDeps) {
  const batchId = await stagedBatch(deps, {
    extractType: 'b3_movimentacao',
    records: [
      subscriptionExercise({
        assetCode: 'XXXX12',
        assetClass: 'fii',
        quantity: Quantity.fromString('7'),
        tradeDate: BusinessDate.of('2024-01-22'),
      }),
      atualizacaoCredit({
        assetCode: 'XXXX11',
        assetClass: 'fii',
        quantity: Quantity.fromString('7'),
        tradeDate: BusinessDate.of('2024-02-22'),
      }),
    ],
  });
  const committed = await commitBatch(deps, userId, { batchId });
  if (!committed.ok) throw new Error('setup: commit failed');
  expect(committed.value.resolvedSubscriptions).toBe(0);

  const rows = await deps.rows.listByBatch(batchId);
  const exerciseRow = findRow(rows, 'XXXX12');
  const creditRow = findRow(rows, 'XXXX11');
  const classified = await classifyImportRow(deps, { rowId: creditRow.id, type: 'bonificacao' });
  if (!classified.ok) throw new Error('setup: classify failed');

  return { batchId, exerciseRow, creditRow, creditTransactionId: classified.value.transaction.id };
}

/**
 * SPEC-006 BR-006-15 (#157 review F3) — a stray sale on `row`'s own position
 * for more than it ever held, so `guardReplayable` refuses any edit whose
 * scope includes that position. Inserted directly (bypassing staging and
 * commit) precisely to exercise the guard itself, independent of whether the
 * edit's own fields could ever produce this on their own.
 */
async function insertUnreplayableSell(deps: FakeIngestionDeps, row: ImportRow): Promise<void> {
  const quantity = Quantity.fromString('5');
  const unitPrice = Money.fromString('10');
  await deps.transactions.insertMany([
    {
      id: TransactionId.generate(),
      userId,
      assetId: row.assetId,
      institutionId: row.institutionId,
      type: 'sell',
      status: 'active',
      tradeDate: BusinessDate.of('2024-12-31'),
      quantity,
      unitPrice,
      fees: Money.zero(),
      totalValue: computeTotalValue('sell', quantity, unitPrice, Money.zero()),
      ratio: null,
      conversionGroupId: null,
      costBasis: null,
      naturalKey: `rogue-sell-${row.id}`,
      occurrence: 1,
      importBatchId: null,
      isManual: true,
      isUserModified: false,
      costIsEstimate: false,
      estimateCloseDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
}

describe('findSubscriptionOffers (SPEC-005 BR-005-20d, #157)', () => {
  it('finds an offer for a locked, zero-cost hand-classified credit, with the stored close', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { batchId, exerciseRow, creditRow, creditTransactionId } = await setupOfferedPair(deps);
    deps.closePrices.seed(
      creditRow.assetId,
      BusinessDate.of('2024-02-22'),
      Money.fromString('114.90'),
    );

    const rows = await deps.rows.listByBatch(batchId);
    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    const offer = offers.get(exerciseRow.id);
    expect(offer).toBeDefined();
    expect(offer?.exerciseRowId).toBe(exerciseRow.id);
    expect(offer?.creditTransactionId).toBe(creditTransactionId);
    expect(offer?.creditAssetCode).toBe('XXXX11');
    expect(offer?.creditType).toBe('bonificacao');
    expect(offer?.tradeDate).toBe('2024-02-22');
    expect(offer?.quantity.toString()).toBe('7');
    expect(offer?.close?.date).toBe('2024-02-22');
    expect(asStored(offer?.close?.close as Money)).toBe('114.90000000');
  });

  it('finds the offer with close: null when no close is stored yet', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { batchId, exerciseRow } = await setupOfferedPair(deps);

    const rows = await deps.rows.listByBatch(batchId);
    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    expect(offers.get(exerciseRow.id)?.close).toBeNull();
  });

  it('finds nothing for a locked, costed credit — evidence_only territory, not an offer', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { batchId, exerciseRow, creditTransactionId } = await setupOfferedPair(deps);
    const priced = await editTransaction(deps, creditTransactionId, {
      unitPrice: Money.fromString('50'),
    });
    expect(priced.ok).toBe(true);

    const rows = await deps.rows.listByBatch(batchId);
    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    expect(offers.has(exerciseRow.id)).toBe(false);
  });

  it('finds nothing once the exercise row is no longer unclassified', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { batchId, exerciseRow } = await setupOfferedPair(deps);
    const kept = await keepSubscriptionClassification(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });
    expect(kept.ok).toBe(true);

    const rows = await deps.rows.listByBatch(batchId);
    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    expect(offers.has(exerciseRow.id)).toBe(false);
  });

  it('finds nothing for a row not shaped like an unclassified exercise', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [buy()],
    });
    const rows = await deps.rows.listByBatch(batchId);

    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    expect(offers.size).toBe(0);
  });

  it("SPEC-005 BR-005-20d (#157 review F1) — finds nothing when a conversion definition already names the credit's code (WIZS3 → WIZC3, real v6 definition)", async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'WIZC12',
          assetClass: 'stock',
          quantity: Quantity.fromString('10'),
          tradeDate: BusinessDate.of('2024-01-01'),
        }),
        // WIZC3 is `wizs3-to-wizc3`'s target — an asset-conversion
        // definition already names it, so BR-005-20d refuses the pair
        // outright, before this ever becomes an `offer` (#157 review F1).
        atualizacaoCredit({
          assetCode: 'WIZC3',
          assetClass: 'stock',
          quantity: Quantity.fromString('10'),
          tradeDate: BusinessDate.of('2024-01-20'),
        }),
      ],
    });
    const committed = await commitBatch(deps, userId, { batchId });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.resolvedSubscriptions).toBe(0);

    const rows = await deps.rows.listByBatch(batchId);
    const creditRow = rows.find(
      (r) => r.record.kind === 'transaction' && r.record.assetCode === 'WIZC3',
    ) as ImportRow;
    const classified = await classifyImportRow(deps, { rowId: creditRow.id, type: 'bonificacao' });
    expect(classified.ok).toBe(true);

    const offers = await findSubscriptionOffers(deps, rows, WINDOW_DAYS);

    expect(offers.size).toBe(0);
  });
});

describe('resolveSubscriptionOffer (SPEC-005 BR-005-20d, #157, DL-005-25) — Resolve as subscription', () => {
  it('re-types the credit at the stored close (key kept, marked an estimate with the close date), supersedes the exercise, ignores its row, raises the main position, and re-derives a downstream carried transfer', async () => {
    // "Today" must be on or after the transfer's own trade date (2024-03-10)
    // below, or the transfer is refused as future-dated regardless of everything else.
    const deps = buildFakeIngestionDeps('2024-04-01');
    const ORIGEM = 'Corretora Origem';
    const DESTINO = 'Corretora Destino';

    const historyBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        // 90 @ 10,00 = 900,00 — deliberately not equal to the subscription's
        // own quantity below (10), so the credit's balance-before (D8) never
        // coincides with what it adds.
        buy({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          institutionName: ORIGEM,
          tradeDate: BusinessDate.of('2024-01-05'),
          quantity: Quantity.fromString('90'),
          unitPrice: Money.fromString('10'),
          fees: Money.zero(),
        }),
      ],
    });
    expect((await commitBatch(deps, userId, { batchId: historyBatch })).ok).toBe(true);

    const pairBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          institutionName: ORIGEM,
          quantity: Quantity.fromString('10'),
          tradeDate: BusinessDate.of('2024-01-10'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          institutionName: ORIGEM,
          quantity: Quantity.fromString('10'),
          tradeDate: BusinessDate.of('2024-02-10'),
        }),
      ],
    });
    expect((await commitBatch(deps, userId, { batchId: pairBatch })).ok).toBe(true);

    const pairRows = await deps.rows.listByBatch(pairBatch);
    const exerciseRow = findRow(pairRows, 'XXXX12');
    const creditRow = findRow(pairRows, 'XXXX11');
    // Hand-classified, before #157, as a zero-cost bonificação — 10 shares
    // added at no cost: ORIGEM stands at 100 shares / 900,00 / 9,00.
    const classified = await classifyImportRow(deps, { rowId: creditRow.id, type: 'bonificacao' });
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const originalNaturalKey = classified.value.transaction.naturalKey;

    // A price-less custody transfer of 25 shares, ORIGEM → DESTINO, carries
    // at ORIGEM's average immediately before the debit: 900,00 ÷ 100 = 9,00.
    const transferBatch = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        transferLeg('credit', {
          institutionName: DESTINO,
          assetCode: 'XXXX11',
          assetClass: 'fii',
          tradeDate: BusinessDate.of('2024-03-10'),
          quantity: Quantity.fromString('25'),
        }),
        transferLeg('debit', {
          institutionName: ORIGEM,
          assetCode: 'XXXX11',
          assetClass: 'fii',
          tradeDate: BusinessDate.of('2024-03-10'),
          quantity: Quantity.fromString('25'),
        }),
      ],
    });
    expect((await commitBatch(deps, userId, { batchId: transferBatch })).ok).toBe(true);

    const mainAssetId = creditRow.assetId;
    const transferInBefore = deps.transactions.rows.find(
      (t) => t.type === 'transfer_in' && t.assetId === mainAssetId,
    ) as Transaction;
    expect(transferInBefore).toBeDefined();
    expect(asStored(transferInBefore.unitPrice)).toBe('9.00000000');

    // A real price becomes known: DL-005-22's own close, on the credit's date.
    deps.closePrices.seed(mainAssetId, BusinessDate.of('2024-02-10'), Money.fromString('27.00'));

    const result = await resolveSubscriptionOffer(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // SPEC-007 BR-007-06: key kept, marked an estimate with the close date.
    const creditTransaction = await deps.transactions.findById(classified.value.transaction.id);
    expect(creditTransaction).toMatchObject({
      type: 'subscription',
      status: 'active',
      isUserModified: true,
      costIsEstimate: true,
      estimateCloseDate: '2024-02-10',
      naturalKey: originalNaturalKey,
    });
    expect(asStored((creditTransaction as Transaction).unitPrice)).toBe('27.00000000');
    expect((creditTransaction as Transaction).fees.isZero()).toBe(true);

    // The exercise supersedes and leaves Needs attention.
    const exerciseTransaction = await deps.transactions.findById(
      exerciseRow.transactionId as TransactionId,
    );
    expect(exerciseTransaction?.status).toBe('superseded');
    const updatedExerciseRow = await deps.rows.findById(exerciseRow.id);
    expect(updatedExerciseRow?.classification).toBe('ignored');

    // SPEC-005 BR-005-20d (#157 review F2): recomputed from the batch's own
    // rows, not a ±1 adjustment — the credit's row is `new` (classified
    // earlier) and the exercise's is now `ignored`, so nothing is left
    // needing attention on this batch.
    const batchAfter = await deps.batches.findById(pairBatch);
    expect(batchAfter?.rowCounts).toMatchObject({
      read: 2,
      new: 1,
      duplicates: 0,
      ignored: 1,
      needsAttention: 0,
    });

    // Preço médio rises: 900,00 (history) + 270,00 (the now-costed
    // subscription, 10 @ 27,00) ÷ 100 = 11,70 — up from the bonificação's
    // diluted 9,00.
    const origemLedger = (await deps.transactions.listAll()).filter(
      (t) => t.assetId === mainAssetId && t.institutionId === creditRow.institutionId,
    );
    const origemReplayed = replayPosition(origemLedger);
    expect(origemReplayed.ok).toBe(true);
    if (!origemReplayed.ok) return;
    expect(origemReplayed.value.quantity.toString()).toBe('75');
    expect(asStored(origemReplayed.value.totalCost)).toBe('877.50000000');
    expect(asStored(origemReplayed.value.averageCost)).toBe('11.70000000');

    // #144 D19: the downstream carried transfer leg is re-derived in the same
    // call, at the new average (1.170,00 ÷ 100 = 11,70) — no re-import needed.
    expect(result.value.rederived.map((t) => t.id)).toEqual([transferInBefore.id]);
    const transferInAfter = await deps.transactions.findById(transferInBefore.id);
    expect(asStored((transferInAfter as Transaction).unitPrice)).toBe('11.70000000');
  });

  it('refuses SUBSCRIPTION_CLOSE_MISSING without a stored close, writing nothing (D1)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { exerciseRow, creditTransactionId } = await setupOfferedPair(deps);

    const result = await resolveSubscriptionOffer(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IngestionUseCaseErrorCode.SUBSCRIPTION_CLOSE_MISSING);

    const creditTransaction = await deps.transactions.findById(creditTransactionId);
    expect(creditTransaction).toMatchObject({ type: 'bonificacao', status: 'active' });
    const updatedExerciseRow = await deps.rows.findById(exerciseRow.id);
    expect(updatedExerciseRow?.classification).toBe('unclassified');
  });

  it('refuses SUBSCRIPTION_OFFER_UNAVAILABLE for a row with no offer (stale or never paired)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'LONE2',
          assetClass: 'fii',
          quantity: Quantity.fromString('5'),
          tradeDate: BusinessDate.of('2024-01-01'),
        }),
      ],
    });
    expect((await commitBatch(deps, userId, { batchId })).ok).toBe(true);
    const rows = await deps.rows.listByBatch(batchId);
    const exerciseRow = findRow(rows, 'LONE2');

    const result = await resolveSubscriptionOffer(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IngestionUseCaseErrorCode.SUBSCRIPTION_OFFER_UNAVAILABLE);
  });

  it('refuses ROW_NOT_FOUND for an unknown row id', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');

    const result = await resolveSubscriptionOffer(deps, {
      rowId: ImportRowId.generate(),
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IngestionUseCaseErrorCode.ROW_NOT_FOUND);
  });

  it('SPEC-006 BR-006-15 (#157 review F3) — refuses and writes nothing when the exercise position cannot replay', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { exerciseRow, creditRow, creditTransactionId } = await setupOfferedPair(deps);
    deps.closePrices.seed(creditRow.assetId, BusinessDate.of('2024-02-22'), Money.fromString('50'));
    await insertUnreplayableSell(deps, exerciseRow);

    const result = await resolveSubscriptionOffer(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PositionErrorCode.INSUFFICIENT_QUANTITY);

    // Neither leg was written — the guard covers both scopes together.
    const exerciseTransaction = await deps.transactions.findById(
      exerciseRow.transactionId as TransactionId,
    );
    expect(exerciseTransaction?.status).toBe('unclassified');
    const creditTransaction = await deps.transactions.findById(creditTransactionId);
    expect(creditTransaction).toMatchObject({ type: 'bonificacao', status: 'active' });
    const untouchedExerciseRow = await deps.rows.findById(exerciseRow.id);
    expect(untouchedExerciseRow?.classification).toBe('unclassified');
  });

  it('a later re-import changes nothing (BR-005-17/AR-19)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('7'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('7'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    };
    const firstBatchId = await stagedBatch(deps, extract);
    expect((await commitBatch(deps, userId, { batchId: firstBatchId })).ok).toBe(true);

    const rows = await deps.rows.listByBatch(firstBatchId);
    const exerciseRow = findRow(rows, 'XXXX12');
    const creditRow = findRow(rows, 'XXXX11');
    const classified = await classifyImportRow(deps, { rowId: creditRow.id, type: 'bonificacao' });
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;

    deps.closePrices.seed(creditRow.assetId, BusinessDate.of('2024-02-22'), Money.fromString('50'));
    const resolved = await resolveSubscriptionOffer(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });
    expect(resolved.ok).toBe(true);

    const secondBatchId = await stagedBatch(deps, extract);
    const secondRows = await deps.rows.listByBatch(secondBatchId);
    // The credit's key survived the resolve (BR-005-17): the re-import
    // matches both rows against their existing occurrence, staging neither
    // fresh.
    expect(secondRows.map((r) => r.classification)).toEqual(['duplicate', 'duplicate']);
    const transactionsBefore = deps.transactions.rows.length;

    const second = await commitBatch(deps, userId, { batchId: secondBatchId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.resolvedSubscriptions).toBe(0);
    expect(deps.transactions.rows.length).toBe(transactionsBefore); // No new transaction inserted.

    const creditTransaction = await deps.transactions.findById(classified.value.transaction.id);
    expect(asStored((creditTransaction as Transaction).unitPrice)).toBe('50.00000000');
    expect(creditTransaction?.status).toBe('active');
  });
});

describe('keepSubscriptionClassification (SPEC-005 BR-005-20d, #157, DL-005-25) — Keep my classification', () => {
  it('supersedes only the exercise and ignores its row — the credit is untouched', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { batchId, exerciseRow, creditRow, creditTransactionId } = await setupOfferedPair(deps);

    const result = await keepSubscriptionClassification(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const creditTransaction = await deps.transactions.findById(creditTransactionId);
    expect(creditTransaction).toMatchObject({ type: 'bonificacao', status: 'active' });
    expect((creditTransaction as Transaction).unitPrice.isZero()).toBe(true);
    expect(creditTransaction?.isUserModified).toBe(true);

    const exerciseTransaction = await deps.transactions.findById(
      exerciseRow.transactionId as TransactionId,
    );
    expect(exerciseTransaction?.status).toBe('superseded');
    const updatedExerciseRow = await deps.rows.findById(exerciseRow.id);
    expect(updatedExerciseRow?.classification).toBe('ignored');

    const creditRowAfter = await deps.rows.findById(creditRow.id);
    expect(creditRowAfter?.classification).toBe('new'); // Unchanged by Keep — set by `classifyImportRow` earlier.

    // SPEC-005 BR-005-20d (#157 review F2/F3): recomputed from the batch's
    // own rows, not a ±1 adjustment. The credit's row is `new`, the
    // exercise's is now `ignored` — nothing left needing attention.
    const batchAfter = await deps.batches.findById(batchId);
    expect(batchAfter?.rowCounts).toMatchObject({
      read: 2,
      new: 1,
      duplicates: 0,
      ignored: 1,
      needsAttention: 0,
    });
  });

  it('refuses SUBSCRIPTION_OFFER_UNAVAILABLE for a row with no offer', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const batchId = await stagedBatch(deps, {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'LONE3',
          assetClass: 'fii',
          quantity: Quantity.fromString('5'),
          tradeDate: BusinessDate.of('2024-01-01'),
        }),
      ],
    });
    expect((await commitBatch(deps, userId, { batchId })).ok).toBe(true);
    const rows = await deps.rows.listByBatch(batchId);
    const exerciseRow = findRow(rows, 'LONE3');

    const result = await keepSubscriptionClassification(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IngestionUseCaseErrorCode.SUBSCRIPTION_OFFER_UNAVAILABLE);
  });

  it('refuses ROW_NOT_FOUND for an unknown row id', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');

    const result = await keepSubscriptionClassification(deps, {
      rowId: ImportRowId.generate(),
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IngestionUseCaseErrorCode.ROW_NOT_FOUND);
  });

  it('SPEC-006 BR-006-15 (#157 review F3) — refuses and writes nothing when the exercise position cannot replay', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const { exerciseRow, creditTransactionId } = await setupOfferedPair(deps);
    await insertUnreplayableSell(deps, exerciseRow);

    const result = await keepSubscriptionClassification(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PositionErrorCode.INSUFFICIENT_QUANTITY);

    const exerciseTransaction = await deps.transactions.findById(
      exerciseRow.transactionId as TransactionId,
    );
    expect(exerciseTransaction?.status).toBe('unclassified');
    const creditTransaction = await deps.transactions.findById(creditTransactionId);
    expect(creditTransaction).toMatchObject({ type: 'bonificacao', status: 'active' });
    const untouchedExerciseRow = await deps.rows.findById(exerciseRow.id);
    expect(untouchedExerciseRow?.classification).toBe('unclassified');
  });

  it('a later re-import changes nothing (BR-005-17/AR-19)', async () => {
    const deps = buildFakeIngestionDeps('2024-03-01');
    const extract: ParsedExtract = {
      extractType: 'b3_movimentacao',
      records: [
        subscriptionExercise({
          assetCode: 'XXXX12',
          assetClass: 'fii',
          quantity: Quantity.fromString('7'),
          tradeDate: BusinessDate.of('2024-01-22'),
        }),
        atualizacaoCredit({
          assetCode: 'XXXX11',
          assetClass: 'fii',
          quantity: Quantity.fromString('7'),
          tradeDate: BusinessDate.of('2024-02-22'),
        }),
      ],
    };
    const firstBatchId = await stagedBatch(deps, extract);
    expect((await commitBatch(deps, userId, { batchId: firstBatchId })).ok).toBe(true);

    const rows = await deps.rows.listByBatch(firstBatchId);
    const exerciseRow = findRow(rows, 'XXXX12');
    const creditRow = findRow(rows, 'XXXX11');
    const classified = await classifyImportRow(deps, { rowId: creditRow.id, type: 'bonificacao' });
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;

    const kept = await keepSubscriptionClassification(deps, {
      rowId: exerciseRow.id,
      windowDays: WINDOW_DAYS,
    });
    expect(kept.ok).toBe(true);

    const secondBatchId = await stagedBatch(deps, extract);
    const secondRows = await deps.rows.listByBatch(secondBatchId);
    expect(secondRows.map((r) => r.classification)).toEqual(['duplicate', 'duplicate']);
    const transactionsBefore = deps.transactions.rows.length;

    const second = await commitBatch(deps, userId, { batchId: secondBatchId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.resolvedSubscriptions).toBe(0);
    expect(deps.transactions.rows.length).toBe(transactionsBefore);

    const creditTransaction = await deps.transactions.findById(classified.value.transaction.id);
    expect(creditTransaction).toMatchObject({ type: 'bonificacao', status: 'active' });
    expect((creditTransaction as Transaction).unitPrice.isZero()).toBe(true);
  });
});
