import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, max, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, ImportBatchId, InstitutionId, TransactionId, UserId } from '@/core/shared/ids';
import type {
  Pagination,
  TransactionFilter,
  TransactionListItem,
  TransactionPage,
  TransactionRepository,
} from '@/core/ledger/ports';
import type { Transaction, TransactionStatus, TransactionType } from '@/core/ledger/transaction';
import { assets, institutions } from '@/db/schema/assets';
import { transactions } from '@/db/schema/transactions';
import { walletAllocations } from '@/db/schema/wallets';
import type { Tx } from '@/db/tenant';

/**
 * SPEC-006's ledger persistence.
 *
 * AR-11: every method here runs on a `Tx` obtained from `withTenant`, never on
 * `db` directly. The tenant filter is therefore **not** written into the WHERE
 * clauses below — RLS applies it, and it fails closed: a query that somehow
 * ran outside `withTenant` raises rather than returning every tenant's rows
 * (TS-16). Adding a redundant `eq(user_id, …)` here would be harmless but
 * misleading, because it would suggest the filter is what protects the data.
 *
 * The one exception is **writes**, which must state `user_id` explicitly for
 * the policy's `WITH CHECK` to have something to verify.
 */
export class DrizzleTransactionRepository implements TransactionRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async findById(id: TransactionId): Promise<Transaction | null> {
    const [row] = await this.tx.select().from(transactions).where(eq(transactions.id, id));
    return row ? toDomain(row) : null;
  }

  async listForPosition(
    assetId: AssetId,
    institutionId: InstitutionId | null,
  ): Promise<readonly Transaction[]> {
    const rows = await this.tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.assetId, assetId),
          // A null institution is a *bucket*, not a wildcard — `= NULL` is
          // never true in SQL, so matching it needs IS NULL. Getting this wrong
          // would silently replay an empty ledger and report a position of
          // zero for every holding with no institution recorded.
          institutionId === null
            ? isNull(transactions.institutionId)
            : eq(transactions.institutionId, institutionId),
        ),
      );
    return rows.map(toDomain);
  }

  async listAll(): Promise<readonly Transaction[]> {
    const rows = await this.tx.select().from(transactions);
    return rows.map(toDomain);
  }

  async search(filter: TransactionFilter, pagination: Pagination): Promise<TransactionPage> {
    const where = buildWhere(filter, this.tx);

    const rows = await this.baseQuery(where)
      // BR-006-07: newest first, and **fully deterministic** down to the id.
      // Two rows tied on date and timestamp would otherwise be free to swap
      // places between pages, which over 10.000 rows means an item shown twice
      // and another never shown at all.
      .orderBy(desc(transactions.tradeDate), desc(transactions.createdAt), desc(transactions.id))
      .limit(pagination.limit)
      .offset(pagination.offset);

    const [totals] = await this.tx
      .select({ value: count() })
      .from(transactions)
      .innerJoin(assets, eq(assets.id, transactions.assetId))
      .where(where);

    return { items: rows.map(toListItem), total: totals?.value ?? 0 };
  }

  async export(filter: TransactionFilter): Promise<readonly TransactionListItem[]> {
    // BR-006-10: the export honours the *active filters* — the same predicate
    // the list built, so "export what I am looking at" cannot widen to the
    // whole ledger by accident. Ascending here rather than descending: an
    // exported ledger is read chronologically.
    const rows = await this.baseQuery(buildWhere(filter, this.tx)).orderBy(
      asc(transactions.tradeDate),
      asc(transactions.createdAt),
      asc(transactions.id),
    );
    return rows.map(toListItem);
  }

  async insert(transaction: Transaction): Promise<void> {
    await this.tx.insert(transactions).values(toRow(transaction, this.userId));
  }

  async update(transaction: Transaction): Promise<void> {
    const row = toRow(transaction, this.userId);
    await this.tx
      .update(transactions)
      .set({
        assetId: row.assetId,
        institutionId: row.institutionId,
        type: row.type,
        status: row.status,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fees: row.fees,
        totalValue: row.totalValue,
        ratio: row.ratio,
        naturalKey: row.naturalKey,
        isUserModified: row.isUserModified,
        updatedAt: row.updatedAt,
      })
      .where(eq(transactions.id, transaction.id));
  }

  async deleteByIds(ids: readonly TransactionId[]): Promise<number> {
    if (ids.length === 0) return 0;
    const deleted = await this.tx
      .delete(transactions)
      .where(inArray(transactions.id, [...ids]))
      .returning({ id: transactions.id });
    return deleted.length;
  }

  async nextOccurrence(naturalKey: string): Promise<number> {
    // BR-006-04 / TS-21: `(natural_key, occurrence)` is what is unique, so two
    // genuinely identical same-day trades can both exist. Reading the current
    // maximum is a read-then-write and therefore racy under two concurrent
    // import commits — the database's UNIQUE constraint is what actually keeps
    // the invariant, and the loser of the race sees a constraint violation
    // rather than a silently merged trade.
    const [row] = await this.tx
      .select({ highest: max(transactions.occurrence) })
      .from(transactions)
      .where(eq(transactions.naturalKey, naturalKey));
    return (row?.highest ?? 0) + 1;
  }

  /**
   * SPEC-005's bulk-import counterpart to `nextOccurrence`: one grouped query
   * for every natural key a staged batch touches (typically thousands), so a
   * 10.000-row commit is not 10.000 round trips (BR-005-13's 60s budget).
   * `max(occurrence)` doubles as the existing *count* only because occurrence
   * assignment is always sequential from 1 with no gaps — every writer
   * (`createTransaction`, this repository's own `insert`) goes through
   * `nextOccurrence`/`occurrenceCounts`, never a hand-picked number.
   */
  async occurrenceCounts(naturalKeys: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (naturalKeys.length === 0) return new Map();
    const rows = await this.tx
      .select({ naturalKey: transactions.naturalKey, highest: max(transactions.occurrence) })
      .from(transactions)
      .where(inArray(transactions.naturalKey, [...naturalKeys]))
      .groupBy(transactions.naturalKey);
    return new Map(rows.map((row) => [row.naturalKey, row.highest ?? 0]));
  }

  private baseQuery(where: SQL | undefined) {
    return (
      this.tx
        .select({
          transaction: transactions,
          assetCode: assets.code,
          assetName: assets.name,
          assetClass: assets.assetClass,
          institutionName: institutions.name,
        })
        .from(transactions)
        .innerJoin(assets, eq(assets.id, transactions.assetId))
        // LEFT, not INNER: `institution_id` is nullable and an inner join would
        // silently drop every manually entered holding with no institution.
        .leftJoin(institutions, eq(institutions.id, transactions.institutionId))
        .where(where)
    );
  }
}

/**
 * SPEC-006 BR-006-08: "every filter works independently **and in
 * combination**" — which is what `and(...)` of the present clauses gives,
 * rather than a chain of if/else that only ever applies one.
 *
 * An absent filter contributes no clause at all. An *empty array* is treated
 * the same as absent on purpose: `inArray(x, [])` compiles to a false
 * predicate in SQL, so "the user cleared the type filter" would otherwise
 * render an empty list instead of everything.
 */
function buildWhere(filter: TransactionFilter, tx: Tx): SQL | undefined {
  const clauses: SQL[] = [];

  if (filter.from !== undefined) clauses.push(gte(transactions.tradeDate, filter.from));
  if (filter.to !== undefined) clauses.push(lte(transactions.tradeDate, filter.to));
  if (filter.assetIds !== undefined && filter.assetIds.length > 0) {
    clauses.push(inArray(transactions.assetId, [...filter.assetIds]));
  }
  if (filter.assetClasses !== undefined && filter.assetClasses.length > 0) {
    clauses.push(inArray(assets.assetClass, [...filter.assetClasses]));
  }
  if (filter.types !== undefined && filter.types.length > 0) {
    clauses.push(inArray(transactions.type, [...filter.types]));
  }
  if (filter.institutionIds !== undefined && filter.institutionIds.length > 0) {
    clauses.push(inArray(transactions.institutionId, [...filter.institutionIds]));
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    clauses.push(inArray(transactions.status, [...filter.statuses]));
  }
  if (filter.walletId !== undefined) {
    /**
     * BR-006-08's wallet dimension — see `ports.ts` for why it resolves
     * through allocations rather than through a column on the row.
     *
     * A correlated `IN (SELECT ...)` rather than a join: a join against
     * `wallet_allocations` would multiply rows if the same asset ever gained a
     * second allocation row for one wallet, and `total` is a `count(*)` over
     * the same predicate — a duplicated row would inflate the page count as
     * well as the list. The subquery is also RLS-scoped on its own, so it can
     * never see another tenant's allocations.
     */
    clauses.push(
      inArray(
        transactions.assetId,
        tx
          .select({ assetId: walletAllocations.assetId })
          .from(walletAllocations)
          .where(eq(walletAllocations.walletId, filter.walletId)),
      ),
    );
  }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    // BR-006-09: by code **and** by name. `ilike` rather than `like`, because a
    // user typing `petr4` is looking for PETR4 and being told "no results" is
    // indistinguishable from the data being missing.
    const term = `%${escapeLike(filter.search.trim())}%`;
    const matches = or(ilike(assets.code, term), ilike(assets.name, term));
    if (matches !== undefined) clauses.push(matches);
  }

  if (clauses.length === 0) return undefined;
  return and(...clauses);
}

/**
 * `%` and `_` are wildcards in LIKE, and `\` escapes them. A user searching for
 * an asset name containing `%` should find that name, not every row — and an
 * unescaped `%_%` pattern is a table scan the 10.000-row budget cannot absorb.
 */
function escapeLike(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

type TransactionRow = typeof transactions.$inferSelect;

function toRow(transaction: Transaction, userId: UserId): typeof transactions.$inferInsert {
  return {
    id: transaction.id,
    // AR-11: written explicitly so the policy's WITH CHECK has something to
    // verify. It comes from the verified session (AR-12), never from input.
    userId,
    assetId: transaction.assetId,
    institutionId: transaction.institutionId,
    type: transaction.type,
    status: transaction.status,
    tradeDate: transaction.tradeDate,
    // AR-07: the custom Drizzle type serialises Money/Quantity to the NUMERIC
    // literal. No `Number()`, no `toFixed`, nothing that could produce a float.
    quantity: transaction.quantity,
    unitPrice: transaction.unitPrice,
    fees: transaction.fees,
    totalValue: transaction.totalValue,
    ratio: transaction.ratio,
    naturalKey: transaction.naturalKey,
    occurrence: transaction.occurrence,
    importBatchId: transaction.importBatchId,
    isManual: transaction.isManual,
    isUserModified: transaction.isUserModified,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function toDomain(row: TransactionRow): Transaction {
  return {
    id: TransactionId.of(row.id),
    userId: UserId.of(row.userId),
    assetId: AssetId.of(row.assetId),
    institutionId: row.institutionId === null ? null : InstitutionId.of(row.institutionId),
    // The CHECK constraints in the migration are what make these casts sound:
    // the column cannot hold a value outside the union.
    type: row.type as TransactionType,
    status: row.status as TransactionStatus,
    // AR-29: `date` comes back as `YYYY-MM-DD`; `BusinessDate.of` validates it
    // rather than trusting it, so a schema change to `timestamptz` would fail
    // loudly here instead of shifting every trade by a timezone offset.
    tradeDate: BusinessDate.of(row.tradeDate),
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    fees: row.fees,
    totalValue: row.totalValue,
    ratio: row.ratio,
    naturalKey: row.naturalKey,
    occurrence: row.occurrence,
    importBatchId: row.importBatchId === null ? null : ImportBatchId.of(row.importBatchId),
    isManual: row.isManual,
    isUserModified: row.isUserModified,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toListItem(row: {
  transaction: TransactionRow;
  assetCode: string;
  assetName: string;
  assetClass: string;
  institutionName: string | null;
}): TransactionListItem {
  return {
    transaction: toDomain(row.transaction),
    assetCode: row.assetCode,
    assetName: row.assetName,
    assetClass: row.assetClass,
    institutionName: row.institutionName,
  };
}
