import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId, InstitutionId, TransactionId, WalletId } from '@/core/shared/ids';
import type { Transaction, TransactionStatus, TransactionType } from '@/core/ledger/transaction';

/**
 * AR-02: ports are declared in `core/`, next to the use cases that need them.
 * The Drizzle implementations live in `adapters/db/` and are injected at the
 * composition root — which is what keeps this engine testable with no
 * database at all (AR-01).
 */

/**
 * SPEC-006 BR-006-08: filters, all of which must work independently **and in
 * combination**. Every field is optional; an absent field is "no constraint",
 * not "match nothing".
 */
export interface TransactionFilter {
  readonly from?: BusinessDate | undefined;
  readonly to?: BusinessDate | undefined;
  readonly assetIds?: readonly AssetId[] | undefined;
  readonly assetClasses?: readonly string[] | undefined;
  readonly types?: readonly TransactionType[] | undefined;
  readonly institutionIds?: readonly InstitutionId[] | undefined;
  readonly statuses?: readonly TransactionStatus[] | undefined;
  /** BR-006-09: full-text search on asset **code and name**. */
  readonly search?: string | undefined;
  /**
   * BR-006-08's wallet dimension, and the one filter whose meaning had to be
   * decided rather than read off the column.
   *
   * There is no wallet on a transaction and there cannot be one: SPEC-010
   * allocates *quantity* per `(wallet, asset)` (DM-2), and DL-010-05 is
   * explicit that a share carries no record of which purpose it served. Two
   * hundred PETR4 split 120/80 across two wallets are not two sets of trades;
   * they are one history and a division of the holding it produced.
   *
   * So this filter means **the transactions of the assets this wallet
   * currently holds a slice of** — which is what a user asking "what happened
   * in my Aposentadoria wallet" can actually be shown. It is a view over
   * today's allocations, not history: moving an asset between wallets changes
   * which transactions this returns, because the allocation is the only thing
   * that ever connected them. `Controls.tsx` says so on the control itself
   * rather than leaving the user to infer it.
   */
  readonly walletId?: WalletId | undefined;
}

export interface Pagination {
  readonly limit: number;
  readonly offset: number;
}

/**
 * The read model for the history list (BR-006-07) and the CSV export
 * (BR-006-10). It carries the asset and institution *names* the repository
 * joined in, because a list of 10.000 rows must not turn into 10.000 lookups.
 */
export interface TransactionListItem {
  readonly transaction: Transaction;
  readonly assetCode: string;
  readonly assetName: string;
  readonly assetClass: string;
  readonly institutionName: string | null;
}

export interface TransactionPage {
  readonly items: readonly TransactionListItem[];
  /** Total matching the filter, not the page — the list needs it to paginate. */
  readonly total: number;
}

export interface TransactionRepository {
  findById(id: TransactionId): Promise<Transaction | null>;

  /**
   * The replay input: every row for one `(asset, institution)` position,
   * whatever its status. Filtering to `active` is the engine's job
   * (BR-007-16) and is done in one place, in `selectForReplay` — a repository
   * that pre-filtered would make an `unclassified` row impossible to
   * reclassify and see the position change (a SPEC-007 acceptance criterion).
   */
  listForPosition(
    assetId: AssetId,
    institutionId: InstitutionId | null,
  ): Promise<readonly Transaction[]>;

  /** DM-4: the whole ledger, for a full rebuild. */
  listAll(): Promise<readonly Transaction[]>;

  /** BR-006-07/08/09: the paginated, filtered, searchable history. */
  search(filter: TransactionFilter, pagination: Pagination): Promise<TransactionPage>;

  /** BR-006-10: the same query without pagination, for a filtered export. */
  export(filter: TransactionFilter): Promise<readonly TransactionListItem[]>;

  insert(transaction: Transaction): Promise<void>;
  update(transaction: Transaction): Promise<void>;

  /** BR-006-17: bulk delete. Returns how many rows were actually removed. */
  deleteByIds(ids: readonly TransactionId[]): Promise<number>;

  /**
   * BR-006-04: `natural_key` is unique per user. Two genuinely identical
   * same-day trades are real (TS-21), so the pair `(natural_key, occurrence)`
   * is what is unique and this returns the next free occurrence.
   */
  nextOccurrence(naturalKey: string): Promise<number>;

  /**
   * SPEC-005's bulk-import counterpart to `nextOccurrence`: one query for
   * every natural key a staged batch touches, rather than one query per row.
   * A key absent from the result has no existing occurrence at all (count 0)
   * — `core/ingestion/occurrence.ts`'s `planOccurrences` treats a missing
   * entry and an explicit 0 identically, so the repository is free to omit
   * keys with no rows rather than return a sparse zero-filled map.
   */
  occurrenceCounts(naturalKeys: readonly string[]): Promise<ReadonlyMap<string, number>>;
}
