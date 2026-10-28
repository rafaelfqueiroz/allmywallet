import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, ImportRowId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { NormalizedTransactionRecord, ParsedExtract } from '@/core/ingestion/ports';
import { stageBatch } from '@/core/ingestion/stage-batch';
import { commitBatch } from '@/core/ingestion/test-support/commit';
import { classifyImportRow } from '@/core/ingestion/classify-row';
import { IGNORE_REASON_MAX_LENGTH, ignoreImportRow } from '@/core/ingestion/ignore-row';
import {
  buildFakeIngestionDeps,
  type FakeIngestionDeps,
} from '@/core/ingestion/test-support/build-deps';

const userId = UserId.generate();

function record(b3Type: string): NormalizedTransactionRecord {
  return {
    kind: 'transaction',
    b3Type,
    direction: 'credit',
    assetCode: 'BBAS3',
    assetName: 'Banco do Brasil ON',
    assetClass: 'stock',
    institutionName: 'Corretora Teste',
    tradeDate: BusinessDate.of('2025-05-29'),
    quantity: Quantity.fromString('475'),
    unitPrice: Money.zero(),
    priceStated: false,
    fees: Money.zero(),
    ratio: null,
  };
}

/** One Movimentação row staged and, unless `commit` is false, committed. */
async function stagedRow(
  deps: FakeIngestionDeps,
  b3Type = 'Atualização',
  { commit = true }: { commit?: boolean } = {},
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
  const parsed = record(b3Type);
  const extract: ParsedExtract = {
    extractType: 'b3_movimentacao',
    records: [{ raw: { movimentacao: b3Type }, record: parsed }],
  };
  await stageBatch(deps, userId, { batchId, extract });
  if (commit) await commitBatch(deps, userId, { batchId });
  const row = deps.rows.all.find((r) => r.batchId === batchId);
  if (!row) throw new Error('row not found in test setup');
  return row;
}

describe('SPEC-005 BR-005-20f — ignoreImportRow', () => {
  it('marks an unclassified row ignored with its reason, writing nothing to the ledger', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    expect(row.classification).toBe('unclassified');
    const ledgerBefore = deps.transactions.rows.filter((t) => t.status === 'active');
    const upsertsBefore = deps.positions.upsertCount;

    const result = await ignoreImportRow(deps, {
      rowId: row.id,
      reason: '  Saldo antes da liquidação da compra de 28/05  ',
    });

    expect(result.ok).toBe(true);
    const ignored = await deps.rows.findById(row.id);
    expect(ignored?.classification).toBe('ignored');
    expect(ignored?.ignoredReason).toBe('Saldo antes da liquidação da compra de 28/05');
    // The stored copy stays inert: `superseded` is excluded from replay as
    // `unclassified` was, and the user's decision is protected (BR-006-16).
    const copy = await deps.transactions.findById(row.transactionId!);
    expect(copy).toMatchObject({ status: 'superseded', isUserModified: true });
    expect(deps.transactions.rows.filter((t) => t.status === 'active')).toEqual(ledgerBefore);
    expect(deps.positions.upsertCount).toBe(upsertsBefore);
    // It leaves "Precisa da sua atenção", and the batch's counts say so.
    expect(await deps.rows.listNeedsAttention()).toEqual([]);
    expect((await deps.batches.findById(row.batchId))?.rowCounts).toMatchObject({
      needsAttention: 0,
      ignored: 1,
    });
  });

  it('keeps the batch counts true across ignoring and bringing back', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Um Tipo Novo');
    await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });
    await classifyImportRow(deps, { rowId: row.id, type: 'bonificacao' });

    expect((await deps.batches.findById(row.batchId))?.rowCounts).toMatchObject({
      new: 1,
      needsAttention: 0,
      ignored: 0,
    });
  });

  /**
   * #179 keeps a consumed exercise from being classified again. One the user
   * ignored was consumed by nothing, so BR-005-20 still brings it back.
   */
  it('brings back a subscription exercise the user ignored', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Direitos de Subscrição - Exercido');
    expect(row.classification).toBe('unclassified');
    await ignoreImportRow(deps, { rowId: row.id, reason: 'Exercício que não se concretizou' });

    const classified = await classifyImportRow(deps, { rowId: row.id, type: 'bonificacao' });

    expect(classified.ok).toBe(true);
    expect((await deps.rows.findById(row.id))?.classification).toBe('new');
  });

  it('leaves a batch with no stored counts without counts', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    const batch = await deps.batches.findById(row.batchId);
    await deps.batches.update({ ...batch!, rowCounts: null });

    expect((await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' })).ok).toBe(true);
    expect((await deps.batches.findById(row.batchId))?.rowCounts).toBeNull();
  });

  // PR #267 review: the real lock is proven against Postgres in
  // tests/integration/import-pipeline.test.ts; this checks every path takes it.
  it('takes the import-write lock on commit, ignore and classify alike', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Um Tipo Novo');
    expect(deps.batches.importWriteLocks).toBe(1);

    await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });
    expect(deps.batches.importWriteLocks).toBe(2);

    await classifyImportRow(deps, { rowId: row.id, type: 'bonificacao' });
    expect(deps.batches.importWriteLocks).toBe(3);
  });

  it('can be brought back into calculations under BR-005-20, which clears the reason', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Um Tipo Novo');
    await ignoreImportRow(deps, { rowId: row.id, reason: 'Não movimenta posição' });

    // `bonificacao` reads no price, so the price-less row can take it.
    const classified = await classifyImportRow(deps, { rowId: row.id, type: 'bonificacao' });

    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    // The same stored copy, key and occurrence kept — not a second one.
    expect(classified.value.transaction.id).toBe(row.transactionId);
    expect(classified.value.transaction.status).toBe('active');
    const restored = await deps.rows.findById(row.id);
    expect(restored?.classification).toBe('new');
    expect(restored?.ignoredReason).toBeNull();
  });

  it.each(['', '   ', 'x'.repeat(IGNORE_REASON_MAX_LENGTH + 1), 'motivo\u0000'])(
    'refuses a reason that is blank or too long (%#)',
    async (reason) => {
      const deps = buildFakeIngestionDeps();
      const row = await stagedRow(deps);

      const result = await ignoreImportRow(deps, { rowId: row.id, reason });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('IMPORT_IGNORE_REASON_INVALID');
      // AR-39 / BR-004-04: the user's text never travels in an error's context.
      expect(JSON.stringify(result.error.context)).not.toContain('xxxx');
      expect((await deps.rows.findById(row.id))?.classification).toBe('unclassified');
    },
  );

  it('accepts a reason of exactly the maximum length', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    const reason = 'x'.repeat(IGNORE_REASON_MAX_LENGTH);

    expect((await ignoreImportRow(deps, { rowId: row.id, reason })).ok).toBe(true);
  });

  it('refuses a row that is already classified', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Bonificação em Ativos');
    expect(row.classification).toBe('new');

    const result = await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
  });

  it('refuses a row that is already ignored', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    await ignoreImportRow(deps, { rowId: row.id, reason: 'primeiro motivo' });

    const result = await ignoreImportRow(deps, { rowId: row.id, reason: 'segundo motivo' });

    expect(result.ok).toBe(false);
    expect((await deps.rows.findById(row.id))?.ignoredReason).toBe('primeiro motivo');
  });

  it('refuses a commit refusal (`invalid`), which BR-005-20f does not name', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    await deps.rows.updateClassification(row.id, 'invalid');

    const result = await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
  });

  /**
   * PR #267 review — a classification or re-import that activated the copy
   * after this submission's form was rendered. Overwriting it `superseded`
   * would leave the position it recalculated describing a transaction that no
   * longer counts.
   */
  it('refuses, without overwriting it, a copy another write already activated', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    const copy = await deps.transactions.findById(row.transactionId!);
    await deps.transactions.update({ ...copy!, status: 'active' });

    const result = await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
    expect((await deps.transactions.findById(row.transactionId!))?.status).toBe('active');
    expect((await deps.rows.findById(row.id))?.classification).toBe('unclassified');
  });

  it('refuses when the row itself moved on after it was read', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps);
    // The read sees the row `unclassified`; by the write it is not.
    const stale = {
      ...deps,
      rows: Object.assign(Object.create(deps.rows), {
        findById: async () => row,
        markIgnored: async (id: ImportRowId, reason: string) => {
          await deps.rows.updateClassification(id, 'new');
          return deps.rows.markIgnored(id, reason);
        },
      }),
    };

    const result = await ignoreImportRow(stale, { rowId: row.id, reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
    expect((await deps.rows.findById(row.id))?.ignoredReason).toBeNull();
  });

  it('refuses a row in a batch not yet committed', async () => {
    const deps = buildFakeIngestionDeps();
    const row = await stagedRow(deps, 'Atualização', { commit: false });

    const result = await ignoreImportRow(deps, { rowId: row.id, reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_UNCLASSIFIED');
  });

  it('refuses a row that does not exist', async () => {
    const deps = buildFakeIngestionDeps();

    const result = await ignoreImportRow(deps, { rowId: ImportRowId.generate(), reason: 'motivo' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_ROW_NOT_FOUND');
  });
});
