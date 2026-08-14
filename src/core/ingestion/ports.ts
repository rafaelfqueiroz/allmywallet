import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type {
  AssetId,
  ImportBatchId,
  ImportRowId,
  InstitutionId,
  TransactionId,
  UserId,
} from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';
import type { Result } from '@/core/shared/result';
import type { TransactionType } from '@/core/ledger/transaction';
import type { ReconciliationReport } from '@/core/ingestion/reconcile';
import type { AssetClass } from '@/core/quotes/ports';
import type { FixedIncomeIndexer } from '@/core/valuation/ports';

/**
 * SPEC-005 — ingestion of the three B3 `.xlsx` extracts and the seam a v2
 * Open Finance aggregator plugs into (BR-005-08, PRD §4).
 *
 * AR-01/AR-02: declared here, next to the use cases that need them. Nothing
 * in this directory imports `exceljs`, `next/*`, `drizzle-orm` or `pg` — the
 * `.xlsx` parsers live in `adapters/ingestion/xlsx/` and implement
 * `IngestionPort` from the outside.
 */

/**
 * BR-005-01: three extracts, each with a distinct role. Reused as the value
 * of `import_batches.source` — already declared by SPEC-006
 * (`transactions.ts`'s `IMPORT_SOURCES`), which is why this is not a second,
 * redundant `extract_type` column (see the migration-dispatch report's
 * Decision log).
 */
export const EXTRACT_TYPES = ['b3_movimentacao', 'b3_negociacao', 'b3_posicao'] as const;
export type ExtractType = (typeof EXTRACT_TYPES)[number];

/** BR-005-09/12/13: the batch lifecycle. Matches SPEC-006's existing CHECK. */
export const IMPORT_BATCH_STATUSES = ['pending', 'previewed', 'committed', 'discarded'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/**
 * BR-005-08: the normalized shape everything downstream of a parser adapter
 * consumes. No xlsx cell, sheet name, column index or CPF may cross this
 * boundary — the type simply has no field for one (AR-54).
 *
 * Movimentação and Negociação rows both produce a transaction record;
 * Posição produces a position snapshot instead (below) — it is a
 * point-in-time statement of what B3 believes is held, not a movement.
 */
export interface NormalizedTransactionRecord {
  readonly kind: 'transaction';
  /** The raw B3 type string (`"Compra"`, `"Juros Sobre Capital Próprio"`, …). */
  readonly b3Type: string;
  /** Movimentação's `Entrada/Saída` column — disambiguates a direction-dependent `b3Type` (`core/ingestion/movement-map.ts`). Always `null` for Negociação, which has no such column. */
  readonly direction: 'credit' | 'debit' | null;
  readonly assetCode: string;
  readonly assetName: string;
  readonly assetClass: AssetClass;
  readonly institutionName: string | null;
  readonly tradeDate: BusinessDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly fees: Money;
  /** BR-007-04 — split/grupamento only. */
  readonly ratio: Quantity | null;
}

/** BR-005-06: what the Posição fixed-income tab carries for one CDB/LCI/LCA row. */
export interface NormalizedFixedIncomeDetails {
  /** `null` where the extract's indexer text could not be read (BR-009-13's "cannot be determined"). */
  readonly indexer: FixedIncomeIndexer | null;
  readonly ratePercent: Quantity | null;
  readonly issueDate: BusinessDate | null;
  readonly maturityDate: BusinessDate | null;
  readonly principal: Money | null;
}

export interface NormalizedPositionRecord {
  readonly kind: 'position';
  readonly assetCode: string;
  readonly assetName: string;
  readonly assetClass: AssetClass;
  readonly institutionName: string | null;
  readonly quantity: Quantity;
  /** BR-005-22: the snapshot date every row of a Posição extract shares — the day reconciliation compares against. */
  readonly asOf: BusinessDate;
  /** BR-005-06: present only for the fixed-income tab's rows. */
  readonly fixedIncome: NormalizedFixedIncomeDetails | null;
}

export type NormalizedRecord = NormalizedTransactionRecord | NormalizedPositionRecord;

/**
 * One row exactly as it appeared in the source, by column header — CPF-free
 * (`strip-cpf.ts` runs before this is ever constructed), string-valued only
 * (AR-10: this crosses into `import_rows.raw_payload`, a jsonb column).
 * Kept for BR-005-11's "inspect individual rows before committing" and for
 * support/debugging when a parse looks wrong.
 */
export type RawRow = Readonly<Record<string, string>>;

export interface ParsedRecord {
  readonly raw: RawRow;
  readonly record: NormalizedRecord;
}

export interface ParsedExtract {
  readonly extractType: ExtractType;
  readonly records: readonly ParsedRecord[];
}

export const IngestionErrorCode = {
  /** BR-005-05: the file's structure matches none of the three known extracts. */
  UNRECOGNIZED_STRUCTURE: 'INGESTION_UNRECOGNIZED_STRUCTURE',
  /** BR-005-05: two candidate structures scored equally — genuinely ambiguous. */
  AMBIGUOUS_STRUCTURE: 'INGESTION_AMBIGUOUS_STRUCTURE',
  /** BR-005-02: larger than `import.max_upload_mb`. */
  FILE_TOO_LARGE: 'INGESTION_FILE_TOO_LARGE',
  /** Not a workbook `exceljs` can open at all. */
  UNREADABLE_FILE: 'INGESTION_UNREADABLE_FILE',
} as const;
export type IngestionErrorCode = (typeof IngestionErrorCode)[keyof typeof IngestionErrorCode];

/**
 * BR-005-08 — the seam. The `.xlsx` parsers (`adapters/ingestion/xlsx/`) are
 * one implementation; SPEC-006 manual entry is a second, and does not go
 * through this port at all (it calls `core/ledger/create-transaction`
 * directly); an Open Finance aggregator adapter is a designed-for third
 * (`features.ingestion_adapters`, currently off).
 */
export interface IngestionPort {
  parse(fileBytes: Uint8Array): Promise<Result<ParsedExtract, DomainError<IngestionErrorCode>>>;
}

/** BR-005-10: the preview summary, and what `import_batches.row_counts` persists. */
export interface ImportRowCounts {
  readonly read: number;
  readonly new: number;
  readonly duplicates: number;
  readonly needsAttention: number;
  readonly fromDate: BusinessDate | null;
  readonly toDate: BusinessDate | null;
}

export interface ImportBatch {
  readonly id: ImportBatchId;
  readonly userId: UserId;
  readonly source: ExtractType;
  readonly status: ImportBatchStatus;
  readonly uploadedAt: Date;
  readonly committedAt: Date | null;
  readonly rowCounts: ImportRowCounts | null;
  /**
   * BR-005-22..26. Set only on a committed `b3_posicao` batch. Not part of the
   * issue's original column list (`row_counts` only) — added deliberately in
   * the same migration, since BR-005-23/26 need structured per-asset
   * discrepancy data and a portfolio-level status persisted somewhere, and
   * `row_counts` is a preview-stage summary of an unrelated concern (rows
   * read/new/duplicate), not the right place to overload with it. See the
   * dispatch report's Decision log.
   */
  readonly reconciliation: ReconciliationReport | null;
}

/**
 * BR-005-11/19/20: what a row is, once staged. `position` is a Posição
 * snapshot row (BR-005-22) — it never becomes a ledger transaction itself, so
 * it does not share the new/duplicate/unclassified vocabulary a transaction
 * row does.
 */
export const IMPORT_ROW_CLASSIFICATIONS = [
  'new',
  'duplicate',
  'unclassified',
  'invalid',
  'position',
] as const;
export type ImportRowClassification = (typeof IMPORT_ROW_CLASSIFICATIONS)[number];

export interface ImportRow {
  readonly id: ImportRowId;
  readonly batchId: ImportBatchId;
  readonly raw: RawRow;
  readonly record: NormalizedRecord;
  /**
   * Resolved once, at staging time (`AssetResolverPort`/`InstitutionResolverPort`
   * — an upsert, so a ticker new to the catalog is created here). Stored
   * rather than re-resolved at commit so the two stages cannot disagree about
   * which asset a row refers to.
   */
  readonly assetId: AssetId;
  readonly institutionId: InstitutionId | null;
  readonly classification: ImportRowClassification;
  /** The natural key `core/ledger/natural-key.ts` computed for a transaction row. Null for a position row. */
  readonly naturalKey: string | null;
  readonly occurrence: number | null;
  /**
   * The `TransactionType` this row will be written to the ledger as, decided
   * once at staging time and never recomputed at commit — so a movement-map
   * change deployed between preview and commit cannot make the two
   * disagree about what a row is. Null only for `position` rows.
   */
  readonly ledgerType: TransactionType | null;
  /** Set once `commit-batch` has written the row into the ledger. */
  readonly transactionId: TransactionId | null;
}

export interface ImportBatchRepository {
  insert(batch: ImportBatch): Promise<void>;
  findById(id: ImportBatchId): Promise<ImportBatch | null>;
  update(batch: ImportBatch): Promise<void>;
  /** BR-005-26: the most recently committed batch per source, for the dashboard's freshness read. */
  listCommitted(): Promise<readonly ImportBatch[]>;
  /** The `/import` history list — every batch regardless of status, newest first. */
  listAll(): Promise<readonly ImportBatch[]>;
}

export interface ImportRowRepository {
  insertMany(rows: readonly ImportRow[]): Promise<void>;
  findById(id: ImportRowId): Promise<ImportRow | null>;
  listByBatch(batchId: ImportBatchId): Promise<readonly ImportRow[]>;
  /** BR-005-12: cancel deletes every staged row for the batch. */
  deleteByBatch(batchId: ImportBatchId): Promise<number>;
  /** Commit marks each applied row with the transaction it became. */
  attachTransactions(updates: ReadonlyMap<ImportRowId, TransactionId>): Promise<void>;
  /** BR-005-20: reclassifying a row out of `unclassified`. */
  updateClassification(id: ImportRowId, classification: ImportRowClassification): Promise<void>;
}

/** BR-005-08/BR-005-06: resolves a free-text B3 product name to an asset, creating it if new. */
export interface AssetResolverPort {
  resolve(input: { code: string; name: string; assetClass: AssetClass }): Promise<AssetId>;
}

/** The institution-catalog counterpart — B3 extracts name a broker/bank in free text. */
export interface InstitutionResolverPort {
  resolve(name: string): Promise<InstitutionId>;
}

/**
 * BR-005-06 — the write side of SPEC-009's read-only `FixedIncomeContractPort`
 * (`core/valuation/ports.ts`). SPEC-009 declared the read port and shipped a
 * stub (`NoContractStore`) because this table did not exist yet; this spec
 * creates `fixed_income_contracts` and is therefore the one that writes to it.
 * `upsertByAsset` rather than `insert`: a later Posição import for the same
 * contract updates it in place (BR-005-06's "creating or updating").
 */
export interface FixedIncomeContractWriterPort {
  upsertByAsset(input: {
    assetId: AssetId;
    indexer: FixedIncomeIndexer | null;
    ratePercent: Quantity | null;
    issueDate: BusinessDate;
    maturityDate: BusinessDate | null;
    principal: Money | null;
    source: ImportBatchId;
  }): Promise<void>;
}
