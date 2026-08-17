import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { resolveConfig } from '@/config/resolve';
import { SystemClock } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import type { UserId } from '@/core/shared/ids';
import type { Grouping, Period, ReportWallet, Scope } from '@/core/reporting/ports';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import { runPerformanceReport } from '@/core/reporting/performance/report';
import type { PerformanceReport } from '@/core/reporting/performance/report';
import type { Benchmark, EarningsTreatment } from '@/core/reporting/performance/ports';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';

/**
 * SPEC-012 — everything the Rentabilidade page needs, in one tenant
 * transaction (AR-11).
 *
 * AR-31: the page is a Server Component and calls this, never `db`.
 *
 * **The two config reads are tenant-scoped and must be, which is not
 * cosmetic.** `reports.benchmarks` and `reports.twr_xirr_divergence_points`
 * both carry a user level, so they read `config_overrides` — an RLS-protected
 * table whose policy casts `current_setting('app.user_id')` to uuid. Reading
 * them outside `withTenant` does not fail closed; it raises 22P02 and takes
 * the page down. `resolveConfig` renames that error now, but the fix is to be
 * inside the transaction in the first place.
 */

export interface PerformanceData {
  readonly wallets: readonly ReportWallet[];
  readonly report: Result<PerformanceReport, DomainError<string>>;
  /** BR-012-14: which benchmarks the user asked for, for the toggle state. */
  readonly benchmarks: readonly Benchmark[];
}

export interface PerformanceInput {
  readonly period: Period;
  readonly scope: Scope;
  readonly grouping: Grouping;
  readonly treatment: EarningsTreatment;
}

export async function loadPerformance(
  userId: UserId,
  input: PerformanceInput,
): Promise<PerformanceData> {
  const today = new SystemClock().today();

  return withTenant(userId, async (tx) => {
    const port = new DrizzleReportDataPort(tx, userId);

    const [wallets, earliest, benchmarksSetting, divergenceBasisPoints] = await Promise.all([
      port.listWallets(),
      port.earliestSnapshotDate(),
      resolveConfig('reports.benchmarks', { db: tx, userId }),
      resolveConfig('reports.twr_xirr_divergence_points', { db: tx, userId }),
    ]);

    const benchmarks = benchmarksSetting.value as readonly Benchmark[];

    const report = await runPerformanceReport(
      {
        port,
        // AR-15: `index_series` is shared reference data with no tenant
        // context, so it is read through the global handle rather than this
        // transaction's. Scoping it to the tenant would imply an ownership
        // this table does not have.
        indexSeries: new DrizzleIndexSeriesRepository(db),
      },
      {
        period: input.period,
        scope: input.scope,
        grouping: input.grouping,
        today,
        treatment: input.treatment,
        benchmarks,
        // The registry stores **basis points** so the key can be an integer
        // and still express half a percentage point. `divergesMaterially`
        // takes *percentage points* and divides by 100 itself, so the
        // conversion is one step and happens here, at the boundary, rather
        // than being duplicated in the domain.
        divergencePoints: Quantity.fromString(String(divergenceBasisPoints.value)).dividedBy('100'),
        earliest,
      },
    );

    return { wallets, report, benchmarks };
  });
}
