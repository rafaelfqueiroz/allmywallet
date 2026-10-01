import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, TransactionId, UserId } from '@/core/shared/ids';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
} from '@/core/ledger/test-support/transaction-builder';
import { editTransaction } from '@/core/ledger/edit-transaction';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { rebuildPositions } from '@/core/positions/rebuild';
import { serializePosition } from '@/core/positions/position-state';
import { positionKeyString, type PositionSnapshot } from '@/core/positions/replay';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function unmapped(
  b3Type = 'Um Tipo Novo',
  priceStated = true,
): {
  raw: Record<string, string>;
  record: NormalizedTransactionRecord;
} {
  const record: NormalizedTransactionRecord = {
    kind: 'transaction',
    priceStated,
    b3Type,
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

async function committedUnclassifiedRow(
  deps: FakeIngestionDeps,
  b3Type?: string,
  commit = true,
  priceStated = true,
  recordOverrides: Partial<NormalizedTransactionRecord> = {},
) {
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
  const parsed = unmapped(b3Type, priceStated);
  const extract: ParsedExtract = {
    extractType: 'b3_movimentacao',
    records: [{ ...parsed, record: { ...parsed.record, ...recordOverrides } }],
  };
  await stageBatch(deps, userId, { batchId, extract });
  if (commit) await commitBatch(deps, userId, { batchId });
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

  it.each(['Transferência - Liquidação', 'Um Tipo Novo'])(
    '#155 — classifying %s re-carries downstream costs and keeps the source estimate through a conversion',
    async (b3Type) => {
      // Existing subscription: 100 @ 10 = 1.000 at A; estimated for the
      // ignored-row case. The unclassified case activates its own estimate.
      // Classification activates 100 @ 32,15 + 4,90 fees = 3.219,90.
      // A before the transfer: 200 / 4.219,90 = 21,0995, still estimated.
      // 100 to B carry 2.109,95; conversion into 50 NEW3 carries the same
      // 2.109,95 and estimate, with average 42,199. A keeps 100 / 2.109,95.
      const deps = buildFakeIngestionDeps('2026-06-30');
      const row = await committedUnclassifiedRow(deps, b3Type);
      const activatesEstimate = row.classification === 'unclassified';
      if (activatesEstimate && row.transactionId !== null) {
        const unclassified = await deps.transactions.findById(row.transactionId);
        if (unclassified === null) throw new Error('unclassified fixture transaction missing');
        await deps.transactions.update({
          ...unclassified,
          costIsEstimate: true,
          estimateCloseDate: BusinessDate.of('2026-01-10'),
        });
      }
      const source = {
        ...aTransaction()
          .subscription()
          .on('2026-01-05')
          .quantity('100')
          .price('10')
          .costEstimate('2026-01-05')
          .imported()
          .build(),
        userId,
        assetId: row.assetId,
        institutionId: row.institutionId,
        costIsEstimate: !activatesEstimate,
        estimateCloseDate: activatesEstimate ? null : BusinessDate.of('2026-01-05'),
      };
      const debit = {
        ...aTransaction()
          .transferOut()
          .on('2026-03-01')
          .quantity('100')
          .price('0')
          .imported()
          .build(),
        userId,
        assetId: row.assetId,
        institutionId: row.institutionId,
      };
      const creditBase = {
        ...aTransaction()
          .transferIn()
          .at('B')
          .on('2026-03-01')
          .quantity('100')
          .price('10')
          .imported()
          .build(),
        userId,
        assetId: row.assetId,
        costIsEstimate: !activatesEstimate,
      };
      const credit = {
        ...creditBase,
        naturalKey: naturalKeyFor({ ...creditBase, unitPrice: Money.zero() }),
      };
      const out = {
        ...aTransaction()
          .conversionOut(undefined, '1000')
          .at('B')
          .on('2026-04-01')
          .quantity('100')
          .imported()
          .build(),
        userId,
        assetId: row.assetId,
      };
      const into = {
        ...aTransaction()
          .conversionIn('1000')
          .of('NEW3')
          .at('B')
          .on('2026-04-01')
          .quantity('50')
          .imported()
          .build(),
        userId,
        costIsEstimate: !activatesEstimate,
      };
      await deps.transactions.insertMany([source, debit, credit, out, into]);
      const initial = await rebuildPositions(deps);
      if (!initial.ok) throw new Error('classification fixture does not replay');

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'buy' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction.costIsEstimate).toBe(activatesEstimate);
      expect(result.value.rederived.map((leg) => leg.id).sort()).toEqual(
        [credit.id, out.id, into.id].sort(),
      );
      expect(result.value.recalculations).toHaveLength(3);
      expect((await deps.transactions.findById(credit.id))?.unitPrice.toString()).toBe('21.0995');
      expect((await deps.transactions.findById(credit.id))?.costIsEstimate).toBe(true);
      expect((await deps.transactions.findById(out.id))?.costBasis?.toString()).toBe('2109.95');
      expect((await deps.transactions.findById(into.id))?.costBasis?.toString()).toBe('2109.95');
      expect((await deps.transactions.findById(into.id))?.costIsEstimate).toBe(true);
      const target = (await deps.positions.list()).find((p) => p.assetId === assetIdFor('NEW3'));
      expect(target?.state.averageCost.toString()).toBe('42.199');
      expect(target?.costEstimated).toBe(true);
      const print = (snapshots: readonly PositionSnapshot[]) =>
        JSON.stringify(
          [...snapshots]
            .sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1))
            .map((snapshot) => ({
              key: positionKeyString(snapshot),
              ...serializePosition(snapshot.state),
              costEstimated: snapshot.costEstimated,
            })),
        );
      const incremental = print(await deps.positions.list());
      const rebuilt = await rebuildPositions(deps);
      expect(rebuilt.ok).toBe(true);
      if (rebuilt.ok) expect(print(rebuilt.value)).toBe(incremental);
    },
  );

  describe('BR-005-19 (amended, #110) — an ignored row', () => {
    it('#195 — protects a stated transfer credit before planning and across later derivation and re-import', async () => {
      // Buy 100 @ 10; user-classified credit 100 @ 20 applies before the
      // same-position debit of 100: 200 / 3.000 → 100 / 1.500 at average 15.
      // Later correction of the buy to 12 changes the average to 16, while
      // the human-stated credit remains 20 and its import key stays raw.
      const deps = buildFakeIngestionDeps('2026-06-30');
      const assetId = await deps.assets.resolve({
        code: 'PETR4',
        name: 'Petrobras PN',
        assetClass: 'stock',
        nameStated: true,
        classStated: true,
      });
      const institutionId = await deps.institutions.resolve('Corretora Teste');
      const buy = {
        ...aTransaction().buy().on('2026-01-05').quantity('100').price('10').build(),
        userId,
        assetId,
        institutionId,
      };
      const debit = {
        ...aTransaction()
          .transferOut()
          .on('2026-01-10')
          .quantity('100')
          .price('0')
          .imported()
          .build(),
        userId,
        assetId,
        institutionId,
      };
      await deps.transactions.insertMany([buy, debit]);
      const overrides = {
        unitPrice: Money.fromString('20'),
        fees: Money.zero(),
        direction: 'credit' as const,
      };
      const row = await committedUnclassifiedRow(
        deps,
        'Transferência - Liquidação',
        true,
        true,
        overrides,
      );
      expect(row.classification).toBe('ignored');

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'transfer_in' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction.unitPrice.toString()).toBe('20');
      expect(result.value.transaction.totalValue.toString()).toBe('2000');
      expect(result.value.transaction.isUserModified).toBe(true);
      expect(result.value.transaction.naturalKey).toBe(row.naturalKey);
      expect(result.value.rederived).toEqual([]);
      expect(await deps.transactions.findById(result.value.transaction.id)).toEqual(
        result.value.transaction,
      );
      const position = (await deps.positions.list()).find(
        (snapshot) => snapshot.assetId === assetId && snapshot.institutionId === institutionId,
      );
      expect(position?.state.quantity.toString()).toBe('100');
      expect(position?.state.totalCost.toString()).toBe('1500');
      expect(position?.state.averageCost.toString()).toBe('15');

      const correction = await editTransaction(deps, buy.id, { unitPrice: Money.fromString('12') });
      expect(correction.ok).toBe(true);
      expect(correction.ok && correction.value.rederived).toEqual([]);
      const afterCorrection = await deps.transactions.findById(result.value.transaction.id);
      expect(afterCorrection?.unitPrice.toString()).toBe('20');
      expect(afterCorrection?.isUserModified).toBe(true);
      const again = await committedUnclassifiedRow(
        deps,
        'Transferência - Liquidação',
        true,
        true,
        overrides,
      );
      expect(again.classification).toBe('duplicate');
      expect(await deps.transactions.findById(result.value.transaction.id)).toEqual(
        afterCorrection,
      );
      expect(
        (await deps.positions.list())
          .find(
            (snapshot) => snapshot.assetId === assetId && snapshot.institutionId === institutionId,
          )
          ?.state.totalCost.toString(),
      ).toBe('1600');
    });

    it('#195 — protects the classified credit while re-deriving the later transfer to B', async () => {
      // A buys 200 @ 10, adds classified 100 @ 20, then its same-position
      // debit removes 100 at 4.000 / 300 = 13,333333… . The later 100 to B
      // carry the stored 13,33333333 → cost 1.333,333333, not the old 1.000.
      const deps = buildFakeIngestionDeps('2026-06-30');
      const assetId = await deps.assets.resolve({
        code: 'PETR4',
        name: 'Petrobras PN',
        assetClass: 'stock',
        nameStated: true,
        classStated: true,
      });
      const institutionId = await deps.institutions.resolve('Corretora Teste');
      const buy = {
        ...aTransaction().buy().on('2026-01-05').quantity('200').price('10').build(),
        userId,
        assetId,
        institutionId,
      };
      const samePositionDebit = {
        ...aTransaction()
          .transferOut()
          .on('2026-01-10')
          .quantity('100')
          .price('0')
          .imported()
          .build(),
        userId,
        assetId,
        institutionId,
      };
      const laterDebit = {
        ...aTransaction()
          .transferOut()
          .on('2026-02-01')
          .quantity('100')
          .price('0')
          .imported()
          .build(),
        userId,
        assetId,
        institutionId,
      };
      const creditBase = {
        ...aTransaction()
          .transferIn()
          .at('B')
          .on('2026-02-01')
          .quantity('100')
          .price('10')
          .imported()
          .build(),
        userId,
        assetId,
      };
      const laterCredit = {
        ...creditBase,
        naturalKey: naturalKeyFor({ ...creditBase, unitPrice: Money.zero() }),
      };
      await deps.transactions.insertMany([buy, samePositionDebit, laterDebit, laterCredit]);
      const initial = await rebuildPositions(deps);
      expect(initial.ok).toBe(true);
      const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação', true, true, {
        unitPrice: Money.fromString('20'),
        fees: Money.zero(),
        direction: 'credit',
      });

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'transfer_in' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction.unitPrice.toString()).toBe('20');
      expect(result.value.transaction.isUserModified).toBe(true);
      expect(result.value.transaction.naturalKey).toBe(row.naturalKey);
      expect(result.value.rederived.map((leg) => leg.id)).toEqual([laterCredit.id]);
      expect(result.value.recalculations).toHaveLength(2);
      const storedCredit = await deps.transactions.findById(laterCredit.id);
      expect(storedCredit?.unitPrice.toString()).toBe('13.33333333');
      expect(storedCredit?.totalValue.toString()).toBe('1333.333333');
      const b = (await deps.positions.list()).find(
        (snapshot) => snapshot.institutionId === institutionIdFor('B'),
      );
      expect(b?.state.quantity.toString()).toBe('100');
      expect(b?.state.totalCost.toString()).toBe('1333.333333');
      const print = (snapshots: readonly PositionSnapshot[]) =>
        JSON.stringify(
          [...snapshots]
            .sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1))
            .map((snapshot) => ({
              key: positionKeyString(snapshot),
              ...serializePosition(snapshot.state),
              costEstimated: snapshot.costEstimated,
            })),
        );
      const incremental = print(await deps.positions.list());
      const rebuilt = await rebuildPositions(deps);
      expect(rebuilt.ok).toBe(true);
      if (rebuilt.ok) expect(print(rebuilt.value)).toBe(incremental);
    });

    it('creates its transaction on classification, attaches it and recalculates', async () => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação');
      expect(row.classification).toBe('ignored');
      expect(deps.transactions.rows).toHaveLength(0);

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'buy' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction).toMatchObject({
        type: 'buy',
        status: 'active',
        importBatchId: row.batchId,
      });
      expect(deps.transactions.rows).toHaveLength(1);
      expect(deps.positions.upsertCount).toBeGreaterThan(0);
      const updated = await deps.rows.findById(row.id);
      expect(updated).toMatchObject({
        classification: 'new',
        transactionId: result.value.transaction.id,
      });
    });

    it('BR-005-17: re-importing the file after classifying reports the row as a duplicate', async () => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação');
      const classified = await classifyImportRow(deps, { rowId: row.id, type: 'buy' });
      expect(classified.ok).toBe(true);

      const again = await committedUnclassifiedRow(deps, 'Transferência - Liquidação');

      expect(again.classification).toBe('duplicate');
      expect(deps.transactions.rows).toHaveLength(1);
    });

    it('review 5: restores a superseded transaction as the chosen type rather than creating a second with its key', async () => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação');
      // The state a re-import leaves a pre-#112 mirror in: its unclassified
      // transaction superseded, still holding the row's key and occurrence.
      const supersededId = TransactionId.generate();
      await deps.transactions.insert({
        ...aTransaction().rendimento().on('2026-01-10').quantity('100').price('32.15').build(),
        id: supersededId,
        assetId: row.assetId,
        institutionId: row.institutionId,
        status: 'superseded',
        naturalKey: row.naturalKey as string,
        occurrence: row.occurrence as number,
        importBatchId: row.batchId,
      });
      await deps.rows.attachTransactions(new Map([[row.id, supersededId]]));

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'buy' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transaction).toMatchObject({
        id: supersededId,
        type: 'buy',
        status: 'active',
        naturalKey: row.naturalKey,
        occurrence: row.occurrence,
      });
      // One transaction for that key and occurrence — the constraint Postgres enforces.
      expect(
        deps.transactions.rows.filter(
          (t) => t.naturalKey === row.naturalKey && t.occurrence === row.occurrence,
        ),
      ).toHaveLength(1);
      expect((await deps.rows.findById(row.id))?.classification).toBe('new');
    });

    it('refuses while the batch is still a preview, since nothing is in the ledger yet', async () => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, 'Dividendo - Transferido', false);

      const result = await classifyImportRow(deps, { rowId: row.id, type: 'dividend' });

      expect(result.ok).toBe(false);
      expect(deps.transactions.rows).toHaveLength(0);
    });

    it('surfaces a ledger refusal and leaves the row ignored', async () => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação');

      // BR-006-15: selling what was never bought.
      const result = await classifyImportRow(deps, { rowId: row.id, type: 'sell' });

      expect(result.ok).toBe(false);
      expect((await deps.rows.findById(row.id))?.classification).toBe('ignored');
    });
  });

  it.each([
    ['Transferência - Liquidação', 'buy'],
    ['Transferência', 'transfer_in'],
    ['Dividendo', 'dividend'],
  ] as const)(
    '#108/#110: %s with no price is refused as %s rather than committed at zero',
    async (b3Type, type) => {
      const deps = buildFakeIngestionDeps();
      const row = await committedUnclassifiedRow(deps, b3Type, true, false);

      const result = await classifyImportRow(deps, { rowId: row.id, type });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('IMPORT_ROW_PRICE_NOT_STATED');
    },
  );

  it('#108: a type that never reads the price still classifies a price-less row', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await committedUnclassifiedRow(deps, 'Transferência - Liquidação', true, false);

    const result = await classifyImportRow(deps, { rowId: row.id, type: 'bonificacao' });

    expect(result.ok).toBe(true);
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
