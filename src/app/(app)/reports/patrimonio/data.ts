import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import { runReportQuery } from '@/core/reporting/base-query';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import type { Grouping, Period, ReportWallet, Scope } from '@/core/reporting/ports';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import type { PortfolioValueReport } from '@/core/reporting/portfolio-value/ports';
import { withReportPort } from '@/app/(app)/reports/data';

/**
 * SPEC-013 — everything the Patrimônio page needs, in **one** tenant
 * transaction (AR-11).
 *
 * AR-31: the page is a Server Component and calls this, never `db`. The split
 * also keeps the whole read inside one `withTenant`, so the wallet list, the
 * snapshot range, the opening snapshot and the last import date all come from
 * a single consistent view — five figures on one screen sourced from five
 * database snapshots is how a page ends up internally inconsistent for one
 * request in a thousand, which is the hardest kind of report bug to believe.
 */

export interface PatrimonioData {
  readonly wallets: readonly ReportWallet[];
  readonly query: Result<ReportQueryResult, DomainError<string>>;
  /** `null` whenever the query failed or the range holds nothing. */
  readonly report: PortfolioValueReport | null;
}

export async function loadPatrimonio(
  userId: UserId,
  input: { readonly period: Period; readonly scope: Scope; readonly grouping: Grouping },
): Promise<PatrimonioData> {
  const today = new SystemClock().today();

  return withReportPort(userId, async (port) => {
    const wallets = await port.listWallets();
    const query = await runReportQuery(
      port,
      { period: input.period, scope: input.scope, grouping: input.grouping, today },
      await port.earliestSnapshotDate(),
    );

    if (!query.ok) return { wallets, query, report: null };

    // Both extra reads happen only once the range is known — `findSnapshotBefore`
    // needs its start date, and neither is worth a round trip if the query
    // already failed validation.
    const [opening, lastImportAt] = await Promise.all([
      port.findSnapshotBefore(query.value.range.from),
      port.lastImportAt(),
    ]);

    return {
      wallets,
      query,
      report: buildPortfolioValueReport({
        query: query.value,
        opening,
        grouping: input.grouping,
        today,
        lastImportAt,
      }),
    };
  });
}
