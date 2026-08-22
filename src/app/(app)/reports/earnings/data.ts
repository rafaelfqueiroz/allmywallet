import { withTenant } from '@/db/tenant';
import { SystemClock, type BusinessDate } from '@/core/shared/clock';
import type { AssetId, UserId } from '@/core/shared/ids';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import { monthsBefore } from '@/core/reporting/period';
import type {
  AssetDescriptor,
  Grouping,
  Period,
  ReportWallet,
  Scope,
} from '@/core/reporting/ports';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import { buildEarningsReport } from '@/core/reporting/earnings/report';
import type { EarningsReport } from '@/core/reporting/earnings/ports';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';

/**
 * SPEC-014 — everything the Proventos page needs, in one tenant transaction
 * (AR-11).
 *
 * **Three earning windows, not one.** The selected period answers "how much
 * did this pay"; the trailing twelve months answer BR-014-06's current yield,
 * which is a fixed window whatever period is on screen; and the equal-length
 * window before the period answers BR-014-07's growth. Reading them together
 * keeps all three consistent with one another and with the holdings — five
 * figures sourced from five database snapshots is how a page ends up
 * internally inconsistent for one request in a thousand.
 */

export interface EarningsData {
  readonly wallets: readonly ReportWallet[];
  readonly query: Result<ReportQueryResult, DomainError<string>>;
  readonly report: EarningsReport | null;
}

/**
 * The window immediately before the period, of the same length.
 *
 * Measured in whole months back from each end rather than in days: "the year
 * before this year" is what a reader means by growth, and a day count would
 * shift the comparison by a day per leap year and by two per two-year period.
 */
function previousWindow(range: { from: BusinessDate; to: BusinessDate }): {
  from: BusinessDate;
  to: BusinessDate;
} {
  const months = monthSpan(range.from, range.to);
  return { from: monthsBefore(range.from, months), to: monthsBefore(range.to, months) };
}

function monthSpan(from: BusinessDate, to: BusinessDate): number {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  const span = ((toYear ?? 0) - (fromYear ?? 0)) * 12 + ((toMonth ?? 0) - (fromMonth ?? 0));
  // A period inside one month still compares against the month before it.
  return Math.max(1, span);
}

export async function loadEarnings(
  userId: UserId,
  input: { readonly period: Period; readonly scope: Scope; readonly grouping: Grouping },
): Promise<EarningsData> {
  const today = new SystemClock().today();

  return withTenant(userId, async (tx) => {
    const port = new DrizzleReportDataPort(tx, userId);
    const [wallets, earliest] = await Promise.all([
      port.listWallets(),
      port.earliestSnapshotDate(),
    ]);

    const query = await runReportQuery(
      port,
      { period: input.period, scope: input.scope, grouping: input.grouping, today },
      earliest,
    );
    if (!query.ok) return { wallets, query, report: null };

    const { range } = query.value;
    const previous = previousWindow(range);

    const [earnings, trailing, priorEarnings, allocationEvents] = await Promise.all([
      port.listEarnings(range.from, range.to),
      // BR-014-06: twelve months back from the period's end, not from today —
      // a report about last year should carry that year's current yield.
      port.listEarnings(monthsBefore(range.to, 12), range.to),
      port.listEarnings(previous.from, previous.to),
      // BR-014-12: bounded at the period's end. Nothing that happens after a
      // period can change who earned income during it.
      port.listAllocationEvents(range.to),
    ]);

    /**
     * Descriptors for every asset that paid in **any** of the three windows,
     * not only for what is held today. An asset sold in March still paid in
     * February, and a row with no name is a row a user cannot act on.
     */
    const assetIds: readonly AssetId[] = [
      ...new Set([...earnings, ...trailing, ...priorEarnings].map((earning) => earning.assetId)),
    ];
    const descriptors: readonly AssetDescriptor[] =
      assetIds.length === 0 ? [] : await port.describeAssets(assetIds);

    return {
      wallets,
      query,
      report: buildEarningsReport({
        query: query.value,
        earnings,
        trailing,
        previous: priorEarnings,
        allocationEvents,
        descriptors,
      }),
    };
  });
}
