import { withTenant } from '@/db/tenant';
import { resolveConfig } from '@/config/resolve';
import { SystemClock } from '@/core/shared/clock';
import type { AssetId, UserId } from '@/core/shared/ids';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import type { Grouping, Period, ReportWallet, Scope } from '@/core/reporting/ports';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import { buildCompositionReport } from '@/core/reporting/composition/report';
import type { CompositionReport } from '@/core/reporting/composition/ports';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';

/**
 * SPEC-015 — everything the Composição page needs, in **one** tenant
 * transaction (AR-11).
 *
 * AR-31: the page is a Server Component and calls this, never `db`.
 *
 * **`reports.concentration_threshold_pct` is a user-level key**, so it reads
 * `config_overrides` — an RLS-protected table whose policy casts
 * `current_setting('app.user_id')` to uuid. Reading it outside `withTenant`
 * does not fail closed; it raises 22P02 and takes the page down. SPEC-012's
 * loader learned this the expensive way; the fix is to be inside the
 * transaction in the first place.
 */

export interface CompositionData {
  readonly wallets: readonly ReportWallet[];
  readonly query: Result<ReportQueryResult, DomainError<string>>;
  /** `null` whenever the query failed — there is nothing to compose. */
  readonly report: CompositionReport | null;
}

export async function loadComposition(
  userId: UserId,
  input: { readonly period: Period; readonly scope: Scope; readonly grouping: Grouping },
): Promise<CompositionData> {
  const today = new SystemClock().today();

  return withTenant(userId, async (tx) => {
    const port = new DrizzleReportDataPort(tx, userId);

    const [wallets, earliest, thresholdPct, delayMinutes] = await Promise.all([
      port.listWallets(),
      port.earliestSnapshotDate(),
      resolveConfig('reports.concentration_threshold_pct', { db: tx, userId }),
      // SPEC-008 BR-008-04 — the delay tier. A deployment-level key, but read
      // through the same resolver so a runtime degradation (BR-008-22) is
      // reflected on screen rather than contradicted by it.
      resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
    ]);

    const query = await runReportQuery(
      port,
      { period: input.period, scope: input.scope, grouping: input.grouping, today },
      earliest,
    );

    if (!query.ok) return { wallets, query, report: null };

    /**
     * Both extra reads happen only once the holding set is known — the quote
     * lookup is scoped to the assets actually on screen, and neither is worth
     * a round trip if the query already failed validation.
     */
    const assetIds: readonly AssetId[] = [
      ...new Set(
        query.value.report.groups.flatMap((group) =>
          group.holdings.map((holding) => holding.assetId),
        ),
      ),
    ];

    const [opening, quotedAt] = await Promise.all([
      port.findSnapshotBefore(query.value.range.from),
      port.latestQuoteAt(assetIds),
    ]);

    return {
      wallets,
      query,
      report: buildCompositionReport({
        query: query.value,
        opening,
        thresholdPct: thresholdPct.value,
        quotedAt,
        delayMinutes: delayMinutes.value,
      }),
    };
  });
}
