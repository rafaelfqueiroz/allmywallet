import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { ImportBatchId, UserId } from '@/core/shared/ids';
import { ImportRowId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { TransactionType } from '@/core/ledger/transaction';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { ingestionError, IngestionUseCaseErrorCode } from '@/core/ingestion/errors';
import {
  UNCLASSIFIED_PLACEHOLDER_TYPE,
  importNaturalKeyFor,
  planOccurrences,
} from '@/core/ingestion/occurrence';
import { classifyMovement, isIgnoredMovement } from '@/core/ingestion/movement-map';
import { carriedTransferCosts } from '@/core/ingestion/transfer-cost';
import type {
  ExtractType,
  ImportBatch,
  ImportRow,
  ImportRowCounts,
  ParsedExtract,
  ParsedRecord,
} from '@/core/ingestion/ports';

/**
 * SPEC-005 BR-005-09..11 — parse → classify → stage.
 *
 * `extract` is handed in already parsed: the `.xlsx` parsing itself
 * (`adapters/ingestion/xlsx/`) runs in the worker handler, outside `core/`
 * (AR-01) and outside this use case, which is what keeps this file testable
 * with a hand-built `ParsedExtract` and no file at all.
 *
 * Nothing is written to `transactions` here — BR-005-09's "nothing reaches
 * the ledger before user confirmation" is why staging only ever writes
 * `import_rows` and moves the batch to `previewed`.
 *
 * A single extract is, in practice, homogeneous: Movimentação and Negociação
 * files carry only transaction rows, Posição only position rows (BR-005-01).
 * This is what lets the two kinds be handled as two separate, simple passes
 * below rather than one pass interleaving both.
 */
/**
 * #108 — ledger types whose effect depends on `unitPrice`: a buy, sell or
 * subscription moves cost basis at the price (SPEC-007 BR-007-02/03/06), a
 * `transfer_in` opens the destination lot at the cost carried on the price
 * (`core/positions/apply-transaction.ts`), and proventos are quantity × price.
 *
 * The real Movimentação leaves the price as `-` on 146 such rows, custody
 * transfers above all. Committed at the placeholder zero, a transfer would open
 * a lot at no cost and a dividend would pay nothing, both silently. So such a
 * row is staged `unclassified` instead (BR-005-19): stored, excluded from
 * calculations, and in Needs attention. `bonificacao` is absent because
 * BR-007-05 allows a zero attributed value; `transfer_out`, `split` and
 * `grupamento` never read the price.
 */
export const PRICE_BEARING_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'buy',
  'sell',
  'subscription',
  'transfer_in',
  'dividend',
  'jcp',
  'rendimento',
  'amortization',
]);

export interface StageBatchInput {
  readonly batchId: ImportBatchId;
  readonly extract: ParsedExtract;
}

export interface StageBatchOutcome {
  readonly batch: ImportBatch;
  readonly rows: readonly ImportRow[];
  readonly counts: ImportRowCounts;
  /** BR-005-21: the raw B3 type strings the movement map could not classify — logged by the caller, no values (BR-004-04). */
  readonly unmappedTypes: readonly string[];
}

export async function stageBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: StageBatchInput,
): Promise<Result<StageBatchOutcome, DomainError>> {
  const batch = await deps.batches.findById(input.batchId);
  if (batch === null || batch.userId !== userId) {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_FOUND, { batchId: input.batchId }),
    );
  }
  if (batch.status !== 'pending') {
    return err(
      ingestionError(IngestionUseCaseErrorCode.BATCH_NOT_PENDING, {
        batchId: input.batchId,
        status: batch.status,
      }),
    );
  }
  if (input.extract.records.length === 0) {
    return err(ingestionError(IngestionUseCaseErrorCode.EMPTY_EXTRACT, { batchId: input.batchId }));
  }

  const rows: ImportRow[] =
    input.extract.extractType === 'b3_posicao'
      ? await stagePositionRows(deps, batch.id, input.extract.records)
      : await stageTransactionRows(
          deps,
          batch.id,
          input.extract.extractType,
          input.extract.records,
        );

  await deps.rows.insertMany(rows);

  const counts = summarize(input.extract.records.length, rows);
  const unmappedTypeSet = new Set<string>();
  for (const row of rows) {
    if (row.classification === 'unclassified' && row.record.kind === 'transaction') {
      unmappedTypeSet.add(row.record.b3Type);
    }
  }
  const unmappedTypes = [...unmappedTypeSet];

  // BR-005-03: `source` is corrected to the *detected* type here — at
  // creation time (before any byte has been parsed, in the upload action)
  // it is necessarily a placeholder, since which of the three extracts a
  // file is is exactly what structure detection determines. Staging is the
  // first point that placeholder can be replaced with the truth.
  const updatedBatch: ImportBatch = {
    ...batch,
    source: input.extract.extractType,
    status: 'previewed',
    rowCounts: counts,
  };
  await deps.batches.update(updatedBatch);

  return ok({ batch: updatedBatch, rows, counts, unmappedTypes });
}

async function stagePositionRows(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
  records: readonly ParsedRecord[],
): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  for (const parsed of records) {
    if (parsed.record.kind !== 'position') continue;
    const assetId = await deps.assets.resolve({
      code: parsed.record.assetCode,
      name: parsed.record.assetName,
      assetClass: parsed.record.assetClass,
      // #108 (SPEC-005 BR-005-06a): Posição states the class, by its tab.
      classStated: true,
      nameStated: true,
    });
    const institutionId =
      parsed.record.institutionName === null
        ? null
        : await deps.institutions.resolve(parsed.record.institutionName);
    rows.push({
      id: ImportRowId.generate(),
      batchId,
      raw: parsed.raw,
      record: parsed.record,
      assetId,
      institutionId,
      classification: 'position',
      naturalKey: null,
      occurrence: null,
      ledgerType: null,
      transactionId: null,
    });
  }
  return rows;
}

async function stageTransactionRows(
  deps: IngestionDependencies,
  batchId: ImportBatchId,
  extractType: ExtractType,
  records: readonly ParsedRecord[],
): Promise<ImportRow[]> {
  interface Resolved {
    readonly raw: ParsedRecord['raw'];
    readonly record: Extract<ParsedRecord['record'], { kind: 'transaction' }>;
    readonly assetId: Awaited<ReturnType<IngestionDependencies['assets']['resolve']>>;
    readonly institutionId: Awaited<
      ReturnType<IngestionDependencies['institutions']['resolve']>
    > | null;
    readonly isUnclassified: boolean;
    readonly ledgerType: TransactionType;
    readonly naturalKey: string;
    /** Every other key this same B3 row has had or could have — see `keyForms`. */
    readonly otherKeys: readonly string[];
    readonly keyForms: KeyForms | null;
  }

  const resolved: Resolved[] = [];
  // Keyed by how many planned rows precede it, so file order survives below.
  type IgnoredRow = Pick<Resolved, 'raw' | 'record' | 'assetId' | 'institutionId' | 'naturalKey'>;
  const ignored = new Map<number, IgnoredRow[]>();
  const ignoredInFileOrder: IgnoredRow[] = [];
  for (const parsed of records) {
    if (parsed.record.kind !== 'transaction') continue;
    const record = parsed.record;
    const assetId = await deps.assets.resolve({
      code: record.assetCode,
      name: record.assetName,
      assetClass: record.assetClass,
      // #108: Movimentação and Negociação only guess the class from the ticker.
      classStated: false,
      // Movimentação's `Produto` states a name; Negociação has only the ticker.
      nameStated: extractType === 'b3_movimentacao',
    });
    const institutionId =
      record.institutionName === null
        ? null
        : await deps.institutions.resolve(record.institutionName);

    // BR-005-19 (amended, #110): a mirror of another extract's record. Its key
    // carries the raw B3 type, as an unclassified row's does, so it can never
    // share an occurrence count with a real row — only with its own earlier
    // import, once the user has classified that one by hand (BR-005-17).
    if (isIgnoredMovement(record.b3Type)) {
      const row: IgnoredRow = {
        raw: parsed.raw,
        record,
        assetId,
        institutionId,
        naturalKey: importNaturalKeyFor(
          {
            assetId,
            institutionId,
            type: UNCLASSIFIED_PLACEHOLDER_TYPE,
            tradeDate: record.tradeDate,
            quantity: record.quantity,
            unitPrice: record.unitPrice,
          },
          record.b3Type,
        ),
      };
      ignored.set(resolved.length, [...(ignored.get(resolved.length) ?? []), row]);
      ignoredInFileOrder.push(row);
      continue;
    }

    // BR-005-18: mapped types are classified; BR-005-19: an unmapped one is
    // never dropped — it is staged `unclassified` with a placeholder type
    // (`occurrence.ts`), not rejected. `direction` disambiguates a handful of
    // Movimentação strings that mean opposite things by Entrada/Saída.
    const resolvedType = classifyMovement(record.b3Type, record.direction);
    const isUnclassified =
      resolvedType === null || (!record.priceStated && PRICE_BEARING_TYPES.has(resolvedType));
    const ledgerType = resolvedType ?? UNCLASSIFIED_PLACEHOLDER_TYPE;

    const keyParts = {
      assetId,
      institutionId,
      tradeDate: record.tradeDate,
      quantity: record.quantity,
      unitPrice: record.unitPrice,
    };
    const naturalKey = importNaturalKeyFor(
      { ...keyParts, type: ledgerType },
      isUnclassified ? record.b3Type : null,
    );
    const forms = resolvedType === null ? null : keyFormsFor(keyParts, resolvedType, record.b3Type);

    resolved.push({
      raw: parsed.raw,
      record,
      assetId,
      institutionId,
      isUnclassified,
      ledgerType,
      naturalKey,
      otherKeys: forms === null ? [] : otherKeysThan(forms, naturalKey),
      keyForms: forms,
    });
  }

  // #110: a price-less custody transfer takes the source broker's average cost.
  const carried = await carriedTransferCosts(
    deps.transactions,
    resolved.map((row) => ({
      assetId: row.assetId,
      institutionId: row.institutionId,
      tradeDate: row.record.tradeDate,
      quantity: row.record.quantity,
      ledgerType: row.ledgerType,
      needsCarriedCost:
        row.isUnclassified && row.ledgerType === 'transfer_in' && !row.record.priceStated,
    })),
  );
  const withCosts = resolved.map((row, index): Resolved => {
    const cost = carried.get(index);
    if (cost === undefined || row.keyForms === null) return row;
    // The key keeps what B3 stated (no price), so a re-import keys it the same.
    return {
      ...row,
      record: { ...row.record, unitPrice: cost },
      isUnclassified: false,
      naturalKey: row.keyForms.mapped,
      otherKeys: otherKeysThan(row.keyForms, row.keyForms.mapped),
    };
  });

  // BR-005-15/16/17: one grouped occurrence query for the whole batch.
  //
  // #110 — a row's key depends on how it was classified, and that changes
  // between map versions (v2's unmapped `APLICAÇÃO` is v3's `buy`) and between
  // imports (a transfer whose cost could not be carried last time can be now).
  // An occurrence already in the ledger under any other form of the same B3
  // row counts towards this one, so the row stages as a duplicate rather than
  // a second copy of something the user may already have classified by hand.
  const uniqueKeys = [
    ...new Set([
      ...withCosts.flatMap((row) => [row.naturalKey, ...row.otherKeys]),
      ...ignoredInFileOrder.map((row) => row.naturalKey),
    ]),
  ];
  const existingCounts = await deps.transactions.occurrenceCounts(uniqueKeys);
  const planned = planOccurrences(withCosts, countsAcrossKeyForms(withCosts, existingCounts));
  const plannedIgnored = planOccurrences(ignoredInFileOrder, existingCounts);

  const staged: ImportRow[] = [];
  let ignoredCursor = 0;
  const pushIgnored = (index: number) => {
    for (let n = ignored.get(index)?.length ?? 0; n > 0; n -= 1) {
      const row = plannedIgnored[ignoredCursor];
      ignoredCursor += 1;
      if (row === undefined) return;
      staged.push({
        id: ImportRowId.generate(),
        batchId,
        raw: row.raw,
        record: row.record,
        assetId: row.assetId,
        institutionId: row.institutionId,
        // A duplicate here is a mirror the user already classified by hand.
        classification: row.isDuplicate ? 'duplicate' : 'ignored',
        naturalKey: row.naturalKey,
        occurrence: row.occurrence,
        ledgerType: UNCLASSIFIED_PLACEHOLDER_TYPE,
        transactionId: null,
      });
    }
  };
  planned.forEach((row, index) => {
    pushIgnored(index);
    staged.push({
      id: ImportRowId.generate(),
      batchId,
      raw: row.raw,
      record: row.record,
      assetId: row.assetId,
      institutionId: row.institutionId,
      classification: row.isDuplicate ? 'duplicate' : row.isUnclassified ? 'unclassified' : 'new',
      naturalKey: row.naturalKey,
      occurrence: row.occurrence,
      ledgerType: row.ledgerType,
      transactionId: null,
    });
  });
  pushIgnored(planned.length);
  return staged;
}

/**
 * #110 — the three keys one mapped B3 row can have been written under:
 * `mapped` (classified, BR-005-14 unmodified), `priceless` (mapped but staged
 * `unclassified` for want of a price, #108) and `unmapped` (a map version that
 * did not know the string, `UNCLASSIFIED_PLACEHOLDER_TYPE`). The last two
 * carry the raw B3 type (`importNaturalKeyFor`), and a hand classification
 * keeps whichever it had (`classify-row.ts`).
 */
interface KeyForms {
  readonly mapped: string;
  readonly priceless: string;
  readonly unmapped: string;
}

function keyFormsFor(
  parts: Omit<Parameters<typeof importNaturalKeyFor>[0], 'type'>,
  type: TransactionType,
  b3Type: string,
): KeyForms {
  return {
    mapped: importNaturalKeyFor({ ...parts, type }, null),
    priceless: importNaturalKeyFor({ ...parts, type }, b3Type),
    unmapped: importNaturalKeyFor({ ...parts, type: UNCLASSIFIED_PLACEHOLDER_TYPE }, b3Type),
  };
}

function otherKeysThan(forms: KeyForms, key: string): readonly string[] {
  return [...new Set([forms.mapped, forms.priceless, forms.unmapped])].filter((k) => k !== key);
}

/**
 * Each planned key's existing count plus every distinct other form of it. Two
 * rows can share a key yet differ in their other forms (`Resgate` and
 * `RESGATE ANTECIPADO/` are both `sell`), so the forms are unioned per key.
 */
function countsAcrossKeyForms(
  rows: readonly { readonly naturalKey: string; readonly otherKeys: readonly string[] }[],
  existing: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const forms = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = forms.get(row.naturalKey) ?? new Set<string>([row.naturalKey]);
    for (const key of row.otherKeys) set.add(key);
    forms.set(row.naturalKey, set);
  }
  const counts = new Map(existing);
  for (const [key, set] of forms) {
    counts.set(
      key,
      [...set].reduce((sum, form) => sum + (existing.get(form) ?? 0), 0),
    );
  }
  return counts;
}

function summarize(read: number, rows: readonly ImportRow[]): ImportRowCounts {
  let newCount = 0;
  let duplicateCount = 0;
  let needsAttentionCount = 0;
  let ignoredCount = 0;
  let fromDate: BusinessDate | null = null;
  let toDate: BusinessDate | null = null;

  for (const row of rows) {
    if (row.classification === 'new') newCount += 1;
    else if (row.classification === 'duplicate') duplicateCount += 1;
    else if (row.classification === 'unclassified' || row.classification === 'invalid') {
      needsAttentionCount += 1;
    } else if (row.classification === 'ignored') ignoredCount += 1;

    if (row.record.kind !== 'transaction') continue;
    const date = row.record.tradeDate;
    if (fromDate === null || date < fromDate) fromDate = date;
    if (toDate === null || date > toDate) toDate = date;
  }

  return {
    read,
    new: newCount,
    duplicates: duplicateCount,
    needsAttention: needsAttentionCount,
    ignored: ignoredCount,
    fromDate,
    toDate,
  };
}
