import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BusinessDate } from '@/core/shared/clock';
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
import { deserializeAssetClassBreakdown } from '@/core/valuation/snapshot';
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
 * The report's holdings need a **valued** position, and the valuation itself
 * belongs to SPEC-009. Until the valuation read model is exposed for an
 * arbitrary as-of date (see the report on this task), positions are valued at
 * their cost basis, which is the same defensible floor
 * `ValuationMethod.COST_FALLBACK` uses: never zero, never omitted, because
 * omitting a position understates the portfolio silently.
 *
 * The seam is the port, so replacing this with the real valuation changes this
 * function and nothing else — no report, and none of the grouping or totals
 * arithmetic, knows where the figure came from.
 */
function valuedPositionsFrom(
  rows: readonly {
    assetId: string;
    institutionId: string | null;
    quantity: string;
    averageCost: string;
    totalCost: string;
  }[],
): readonly ReportPosition[] {
  return rows.map((row) => ({
    assetId: AssetId.of(row.assetId),
    institutionId: row.institutionId === null ? null : InstitutionId.of(row.institutionId),
    quantity: Quantity.fromString(row.quantity),
    value: Money.fromString(row.totalCost),
    costBasis: Money.fromString(row.totalCost),
    // BR-011-15: a cost-valued position is not an observed price. Marking it
    // keeps the estimate badge honest rather than presenting cost as market.
    estimated: true,
  }));
}

export class DrizzleReportDataPort implements ReportDataPort {
  constructor(private readonly tx: Tx) {}

  async listValuedPositions(_asOf: BusinessDate): Promise<readonly ReportPosition[]> {
    const rows = await this.tx
      .select({
        assetId: positions.assetId,
        institutionId: positions.institutionId,
        quantity: positions.quantity,
        averageCost: positions.averageCost,
        totalCost: positions.totalCost,
      })
      .from(positions)
      // A position closed to zero is worth nothing, carries no price, and
      // would render as a zero row in every group.
      .where(sql`${positions.quantity} > 0`);
    return valuedPositionsFrom(
      rows.map((row) => ({
        assetId: row.assetId,
        institutionId: row.institutionId,
        quantity: String(row.quantity),
        averageCost: String(row.averageCost),
        totalCost: String(row.totalCost),
      })),
    );
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
  return withTenant(userId, (tx) => fn(new DrizzleReportDataPort(tx)));
}
