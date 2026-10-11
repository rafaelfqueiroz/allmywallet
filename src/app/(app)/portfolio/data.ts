import { withTenant } from '@/db/tenant';
import { resolveConfig } from '@/config/resolve';
import { SystemClock, type BusinessDate, type Clock } from '@/core/shared/clock';
import type { AssetId, UserId } from '@/core/shared/ids';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import type { Grouping, ReportWallet, Scope } from '@/core/reporting/ports';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import { buildCompositionReport } from '@/core/reporting/composition/report';
import type { CompositionReport } from '@/core/reporting/composition/ports';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';

/**
 * SPEC-022 BR-022-02 — **Portfólio: what is held now, valued at the latest
 * quote, with no period.** Everything Patrimônio, Composição and Carteiras'
 * comparison need, in **one** tenant transaction (AR-11).
 *
 * This is SPEC-015's Composição loader, moved here with its page (#208), and
 * the period is the one thing it no longer takes. A current-state view has no
 * period to choose (DL-022-02), so the report runs over the **single day
 * today** — the dashboard's headline query (`dashboard/data.ts`), for the
 * dashboard's reason: `asOfFor` resolves to today, the holding set is valued
 * at today, and `listSnapshots` reads at most one row. The figures are the
 * ones every period ending today already showed; only the period control is
 * gone. No new calculation (#208): the report is SPEC-011's `runReportQuery`
 * folded by SPEC-015's `buildCompositionReport`, exactly as before.
 *
 * Composition drift over time (BR-015-04) needs a period, so it moved to
 * Relatórios › Evolução patrimonial (BR-022-03, #209). The baseline it needs is
 * therefore not read here; `buildCompositionReport` reports the drift as
 * unavailable, and no Portfólio page renders it.
 *
 * AR-31: pages are Server Components and call this, never `db`.
 *
 * **`reports.concentration_threshold_pct` is a user-level key**, so it reads
 * `config_overrides` — an RLS-protected table whose policy casts
 * `current_setting('app.user_id')` to uuid. Reading it outside `withTenant`
 * does not fail closed; it raises 22P02 and takes the page down. SPEC-012's
 * loader learned this the expensive way; the fix is to be inside the
 * transaction in the first place.
 */

export interface CurrentComposition {
  /** The tenant's wallets, for the scope selector (BR-022-17). */
  readonly wallets: readonly ReportWallet[];
  readonly query: Result<ReportQueryResult, DomainError<string>>;
  /** `null` whenever the query failed — there is nothing to compose. */
  readonly report: CompositionReport | null;
  /**
   * SPEC-005 BR-005-27 — every screen showing portfolio value states when
   * custody data was last imported. `null` before the first import.
   */
  readonly lastImportAt: BusinessDate | null;
}

/**
 * `clock` is a parameter for AR-03's reason: the integration test that holds
 * BR-015-10 against Evolução patrimonial pins the date (see
 * `tests/integration/portfolio-current.test.ts`). The pages pass nothing.
 */
export async function loadCurrentComposition(
  userId: UserId,
  input: { readonly scope: Scope; readonly grouping: Grouping },
  clock: Clock = new SystemClock(),
): Promise<CurrentComposition> {
  const today = clock.today();

  return withTenant(userId, async (tx) => {
    const port = new DrizzleReportDataPort(tx, userId, clock);

    const [wallets, earliest, lastImportAt, thresholdPct, delayMinutes] = await Promise.all([
      port.listWallets(),
      port.earliestSnapshotDate(),
      port.lastImportAt(),
      resolveConfig('reports.concentration_threshold_pct', { db: tx, userId }),
      // SPEC-008 BR-008-04 — the delay tier. A deployment-level key, but read
      // through the same resolver so a runtime degradation (BR-008-22) is
      // reflected on screen rather than contradicted by it.
      resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
    ]);

    const query = await runReportQuery(
      port,
      {
        period: { kind: 'custom', from: today, to: today },
        scope: input.scope,
        grouping: input.grouping,
        today,
      },
      earliest,
    );

    if (!query.ok) return { wallets, query, report: null, lastImportAt };

    // The quote lookup is scoped to the assets actually on screen.
    const assetIds: readonly AssetId[] = [
      ...new Set(
        query.value.report.groups.flatMap((group) =>
          group.holdings.map((holding) => holding.assetId),
        ),
      ),
    ];

    return {
      wallets,
      query,
      lastImportAt,
      report: buildCompositionReport({
        query: query.value,
        opening: null,
        thresholdPct: thresholdPct.value,
        quotedAt: await port.latestQuoteAt(assetIds),
        delayMinutes: delayMinutes.value,
      }),
    };
  });
}

/**
 * The scope selector's wallets alone, for the tabs that read no report
 * (Metas). The same `listWallets` read the report tabs get from
 * `loadCurrentComposition`, so the selector lists the same wallets on every
 * tab.
 */
export async function loadScopeWallets(userId: UserId): Promise<readonly ReportWallet[]> {
  return withTenant(userId, (tx) => new DrizzleReportDataPort(tx, userId).listWallets());
}
