import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { SystemClock, type BusinessDate, type Clock } from '@/core/shared/clock';
import { AssetId, InstitutionId, WalletId, type UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type {
  AssetDescriptor,
  DailyValuationSnapshot,
  ReportAllocation,
  ReportDataPort,
  ReportInstitution,
  ReportPosition,
  ReportWallet,
} from '@/core/reporting/ports';
import {
  deserializeAssetClassBreakdown,
  loadValuationContextForAssets,
  type SnapshotDependencies,
} from '@/core/valuation/snapshot';
import { valueHoldingsAt, type Holding } from '@/core/valuation/holdings';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleFixedIncomeContractRepository } from '@/adapters/db/fixed-income-contract-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import type { AssetClass } from '@/core/quotes/ports';
import { db } from '@/db/client';
import { assets, institutions } from '@/db/schema/assets';
import { positions } from '@/db/schema/positions';
import { dailyValuationSnapshots } from '@/db/schema/valuation';
import { walletAllocations, wallets } from '@/db/schema/wallets';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-011 — the Drizzle adapter behind `ReportDataPort` (AR-02).
 *
 * **BR-011-13 / TS-32: every read here is against a derived cache or shared
 * reference data.** `positions` (SPEC-007's cache), `wallet_allocations`,
 * `daily_valuation_snapshots` (SPEC-009's cache), `assets` and `institutions`.
 * The `transactions` table is not imported and not queried — a report answers
 * from what has already been computed, never by replaying five years of ledger
 * per request (DL-011-07).
 *
 * AR-11: the tenant-scoped reads all run inside one `withTenant` transaction,
 * so RLS has its context set exactly once and the whole page renders from a
 * single consistent view of the tenant's data.
 */

/**
 * SPEC-009 valuation, driven from SPEC-007's `positions` cache.
 *
 * **This is the seam that used to report cost basis as market value.** Until
 * the valuation read model was reachable for an arbitrary as-of date, this
 * function returned `total_cost` as `value` and flagged every row an estimate.
 * The time series on the same page was already snapshot-backed, so a portfolio
 * chart moving with the market sat next to a holdings table that never moved —
 * and SPEC-015's Composition report, which is *entirely* current market value,
 * would have been built on it.
 *
 * It now runs the real thing: `valueHoldingsAt` (core/valuation/holdings.ts),
 * the same function the snapshot builder uses, so a holdings table and the
 * chart above it cannot disagree about what a position is worth.
 *
 * **No ledger is read.** Quantities and average costs come from the positions
 * cache, prices from `price_quotes`/`latest_quotes`, contracts from
 * `fixed_income_contracts`, index series from `index_series` — all derived or
 * reference data, which is exactly what DL-011-07 and TS-32 require of a
 * report.
 */
function valuationDeps(tx: Tx, userId: UserId): Omit<SnapshotDependencies, 'snapshots'> {
  return {
    calendar: new B3TradingCalendar(),
    // AR-15: `assets`, `price_quotes` and `index_series` are shared reference
    // data with no tenant column, so they take the pooled `db` rather than the
    // tenant transaction.
    assets: new DrizzleAssetCatalogRepository(db),
    prices: new DrizzleQuoteRepository(db),
    indexSeries: new DrizzleIndexSeriesRepository(db),
    // `fixed_income_contracts` *is* tenant-scoped and FORCEd, so it must run
    // inside the report's own transaction (AR-11) — not the sibling
    // `DrizzleFixedIncomeContractReader`, which opens a second `withTenant`
    // per lookup and would read the tenant's contracts from a different
    // database snapshot than every other figure on the page.
    contracts: new DrizzleFixedIncomeContractRepository(tx, userId),
  };
}

export class DrizzleReportDataPort implements ReportDataPort {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async listValuedPositions(asOf: BusinessDate): Promise<readonly ReportPosition[]> {
    const rows = await this.tx
      .select({
        assetId: positions.assetId,
        institutionId: positions.institutionId,
        quantity: positions.quantity,
        averageCost: positions.averageCost,
      })
      .from(positions)
      // A position closed to zero is worth nothing, carries no price, and
      // would render as a zero row in every group.
      .where(sql`${positions.quantity} > 0`);
    if (rows.length === 0) return [];

    // BR-007-08: one row per (asset, institution), and they stay separate —
    // the report groups by institution, and `valueHoldingsAt` is additive, so
    // valuing the parts gives the same total as valuing the whole (TS-12).
    const holdings: Holding[] = rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      quantity: Quantity.fromString(String(row.quantity)),
      averageCost: Money.fromString(String(row.averageCost)),
    }));

    const context = await loadValuationContextForAssets(
      valuationDeps(this.tx, this.userId),
      holdings.map((holding) => holding.assetId),
      // One date, not a range: a holdings table states what things are worth
      // *now*, and the anchor lookup inside the loader is what carries a close
      // forward across a weekend or a holiday (BR-009-03).
      asOf,
      asOf,
    );

    // BR-009-02's guard rail: an intraday quote may only ever price today.
    // Asking for a past date must use that date's close, or a report of last
    // month would quietly move every time the market ticked.
    const mode = asOf === this.clock.today() ? 'current' : 'historical';

    const valued = valueHoldingsAt(context, holdings, asOf, mode);
    if (!valued.ok) {
      // ASSET_NOT_FOUND is the only failure, and a foreign key makes it
      // unreachable in production. Throwing beats rendering a report with a
      // silently missing holding — see ValuationErrorCode's own note on why
      // this is an error rather than a fallback.
      throw new Error(`report valuation failed: ${valued.error.code}`);
    }

    // `valueHoldingsAt` skips zero-quantity holdings; the SQL filter above
    // means there are none, so the two arrays correspond one to one. Asserted
    // rather than assumed, because the institution column is carried across by
    // position and a silent shift would attribute holdings to the wrong broker.
    if (valued.value.length !== rows.length) {
      throw new Error(
        `report valuation returned ${valued.value.length} of ${rows.length} holdings`,
      );
    }

    return valued.value.map((position, index) => {
      const institutionId = rows[index]?.institutionId ?? null;
      return {
        assetId: position.assetId,
        institutionId: institutionId === null ? null : InstitutionId.of(institutionId),
        quantity: position.quantity,
        value: position.value,
        costBasis: position.costBasis,
        // BR-011-15 / BR-009-11: `true` means *computed* — accrued bank paper,
        // or a position that fell back to cost because nothing could price it.
        // No longer true of every row, which is what made the badge meaningless.
        estimated: position.estimated,
      };
    });
  }

  async listAllocations(): Promise<readonly ReportAllocation[]> {
    const rows = await this.tx
      .select({
        walletId: walletAllocations.walletId,
        assetId: walletAllocations.assetId,
        quantity: walletAllocations.quantity,
      })
      .from(walletAllocations);
    return rows.map((row) => ({
      walletId: WalletId.of(row.walletId),
      assetId: AssetId.of(row.assetId),
      quantity: Quantity.fromString(String(row.quantity)),
    }));
  }

  async listWallets(): Promise<readonly ReportWallet[]> {
    const rows = await this.tx
      .select({ id: wallets.id, name: wallets.name })
      .from(wallets)
      .orderBy(asc(wallets.name));
    return rows.map((row) => ({ walletId: WalletId.of(row.id), name: row.name }));
  }

  async findWallet(walletId: WalletId): Promise<ReportWallet | null> {
    const rows = await this.tx
      .select({ id: wallets.id, name: wallets.name })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    const row = rows[0];
    return row === undefined ? null : { walletId: WalletId.of(row.id), name: row.name };
  }

  /** AR-15: `institutions` is shared reference data — no tenant scope needed. */
  async listInstitutions(): Promise<readonly ReportInstitution[]> {
    const rows = await db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions);
    return rows.map((row) => ({
      institutionId: InstitutionId.of(row.id),
      name: row.name,
    }));
  }

  /** AR-15: `assets` is shared reference data. */
  async describeAssets(assetIds: readonly AssetId[]): Promise<readonly AssetDescriptor[]> {
    if (assetIds.length === 0) return [];
    const rows = await db
      .select({
        id: assets.id,
        code: assets.code,
        name: assets.name,
        assetClass: assets.assetClass,
      })
      .from(assets)
      .where(inArray(assets.id, [...assetIds]));
    return rows.map((row) => ({
      assetId: AssetId.of(row.id),
      code: row.code,
      name: row.name,
      assetClass: row.assetClass as AssetClass,
      // BR-011-10: the catalog has no sector column — sourcing sector data is
      // PRD open question Q5, listed Out of Scope on SPEC-015. Null flows
      // through the same "Not classified" path fixed income does, so the
      // sector view still reconciles with every other view. When the column
      // lands, only this line changes.
      sector: null,
    }));
  }

  async listSnapshots(
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly DailyValuationSnapshot[]> {
    const rows = await this.tx
      .select()
      .from(dailyValuationSnapshots)
      .where(
        and(
          sql`${dailyValuationSnapshots.date} >= ${from}`,
          sql`${dailyValuationSnapshots.date} <= ${to}`,
        ),
      )
      .orderBy(asc(dailyValuationSnapshots.date));

    return rows.map((row) => ({
      date: row.date as BusinessDate,
      totalValue: Money.fromString(String(row.totalValue)),
      netContributions: Money.fromString(String(row.netContributions)),
      earningsToDate: Money.fromString(String(row.earningsToDate)),
      byAssetClass: deserializeAssetClassBreakdown(row.byAssetClass),
      hasEstimates: row.hasEstimates,
    }));
  }

  /** The `all` period's anchor — the first date this tenant has a snapshot for. */
  async earliestSnapshotDate(): Promise<BusinessDate | null> {
    const rows = await this.tx
      .select({ date: dailyValuationSnapshots.date })
      .from(dailyValuationSnapshots)
      .orderBy(asc(dailyValuationSnapshots.date))
      .limit(1);
    return (rows[0]?.date as BusinessDate | undefined) ?? null;
  }
}

/**
 * AR-11 — one tenant transaction for the whole page render, so RLS context is
 * set exactly once and every figure comes from one consistent view.
 */
export async function withReportPort<T>(
  userId: UserId,
  fn: (port: DrizzleReportDataPort) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(new DrizzleReportDataPort(tx, userId)));
}
