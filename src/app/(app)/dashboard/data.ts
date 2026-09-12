import { resolveConfig } from '@/config/resolve';
import { SystemClock, type Clock } from '@/core/shared/clock';
import type { AssetId, UserId } from '@/core/shared/ids';
import { runReportQuery } from '@/core/reporting/base-query';
import { listPendingAllocations } from '@/core/wallets/pending';
import {
  buildDashboardSummary,
  type AssetLabel,
  type DashboardSummary,
  type ReconciliationSource,
} from '@/core/dashboard/summary';
import { DrizzleImportBatchRepository } from '@/adapters/db/import-batch-repository';
import { DrizzleImportRowRepository } from '@/adapters/db/import-row-repository';
import { DrizzleReportDataPort } from '@/app/(app)/reports/data';
import { buildWalletDeps } from '@/app/(app)/wallets/composition';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';
import type { ImportBatch } from '@/core/ingestion/ports';

/**
 * #98 — everything the dashboard needs, in **one** tenant transaction (AR-11).
 *
 * AR-31: the page is a Server Component and calls this, never `db`.
 *
 * **One transaction is not a formality on this screen.** The dashboard puts a
 * portfolio total, a reconciliation verdict and a work queue side by side, and
 * each of the three is a claim about the *same* moment. Sourcing them from
 * three database snapshots is how a screen ends up saying "reconciled" beside a
 * total computed from positions that a commit changed half a millisecond later
 * — internally inconsistent for one request in a thousand, and the hardest kind
 * of report bug to believe. `loadPatrimonio` states the same reasoning.
 *
 * It is also load-bearing for correctness rather than only for consistency:
 * both config reads below hit `config_overrides`, whose RLS policy casts
 * `current_setting('app.user_id')` to uuid. Outside `withTenant` that setting
 * is the empty string and the policy raises 22P02, taking the page down rather
 * than failing closed (SPEC-012's loader learned this the expensive way).
 *
 * **The ports are wired by hand here rather than through
 * `buildIngestionDeps`.** That builder constructs seven repositories, two of
 * which reach the ledger — and the one thing this screen must be structurally
 * incapable of is replaying transactions (SPEC-016 BR-016-05, BR-016-07a).
 * Constructing only the two repositories the dashboard reads makes that a
 * property of the wiring rather than of a scan that happens to pass.
 */

export interface DashboardData {
  readonly summary: DashboardSummary;
}

/**
 * The most recent committed batch that actually carries a reconciliation
 * report (BR-005-26).
 *
 * Only a `b3_posicao` import produces one — a Movimentação or Negociação
 * commit has no B3 position statement to compare the ledger against — so the
 * newest *committed* batch is very often not the newest *reconciled* one. This
 * picks the newest of those that reconciled, which is the last time the
 * question "does my ledger agree with B3" was actually answered.
 */
export function latestReconciliation(batches: readonly ImportBatch[]): ReconciliationSource | null {
  let latest: ImportBatch | null = null;
  for (const batch of batches) {
    if (batch.reconciliation === null || batch.committedAt === null) continue;
    if (latest === null || batch.committedAt > (latest.committedAt as Date)) latest = batch;
  }
  // Non-null assertion avoided: the loop only ever assigns a batch whose
  // `reconciliation` it has already proven non-null, but the compiler cannot
  // carry that across the assignment, so it is re-checked rather than asserted.
  return latest === null || latest.reconciliation === null
    ? null
    : { batchId: latest.id, report: latest.reconciliation };
}

/**
 * `clock` is a parameter for the reason AR-03 makes `Clock` a port at all:
 * every figure on this screen is resolved *as of a date*, and an integration
 * test that cannot pin that date can only assert against whatever day it
 * happens to run on — which means seeding a close for "today" and hoping the
 * date does not roll over mid-run. The page passes nothing and gets the system
 * clock.
 */
export async function loadDashboard(
  userId: UserId,
  clock: Clock = new SystemClock(),
): Promise<DashboardData> {
  const today = clock.today();

  return withTenant(
    userId,
    async (tx) => {
      const port = new DrizzleReportDataPort(tx, userId);
      const batches = new DrizzleImportBatchRepository(tx, userId);
      const rows = new DrizzleImportRowRepository(tx, userId);
      const walletDeps = buildWalletDeps(tx, userId);

      const [committed, unclassified, lastImportAt, delayMinutes, thresholdDays] =
        await Promise.all([
          batches.listCommitted(),
          rows.countNeedsAttentionByBatch(),
          port.lastImportAt(),
          // SPEC-008 BR-008-04 — the delay tier, read through the resolver so a
          // runtime cadence degradation (BR-008-22) is reflected on screen
          // rather than contradicted by it.
          resolveConfig('quotes.cadence_minutes', { db: tx, userId }),
          // BR-005-28 — a **user**-level key, so a quarterly importer's own
          // setting wins over the deployment default here exactly as it does on
          // `/import` and in the reminder job.
          resolveConfig('import.staleness_days', { db: tx, userId }),
        ]);

      /**
       * BR-013-12 — the headline is the **report's** figure, obtained by
       * running the report's own query rather than by computing a total that
       * ought to match it. A single-day custom period is the smallest range
       * that yields it: `asOfFor` resolves to today, the holding set is valued
       * at today, and `listSnapshots` reads at most one row instead of a year
       * of them. The period never reaches the screen — the dashboard answers
       * "what do I have now", not "over what window".
       */
      const query = await runReportQuery(
        port,
        {
          period: { kind: 'custom', from: today, to: today },
          scope: { kind: 'portfolio' },
          // No grouping is rendered; `asset_class` is the portfolio default and
          // the only one that costs no extra query (`runReportQuery` looks up
          // wallets or institutions only when grouped by them).
          grouping: 'asset_class',
          today,
        },
        await port.earliestSnapshotDate(),
      );

      if (!query.ok) {
        // `runReportQuery` fails on an invalid period or a missing wallet.
        // Neither is reachable from here: the period is a single day built from
        // the clock, and the scope is the portfolio. A thrown fault is the
        // honest treatment of an unreachable branch (AR-36 covers *expected*
        // outcomes, and this is not one).
        throw new Error(`dashboard query failed: ${query.error.code}`);
      }

      const holdings = query.value.report.groups.flatMap((group) => group.holdings);
      const assetLabels = new Map<AssetId, AssetLabel>(
        holdings.map((holding) => [
          holding.assetId,
          { code: holding.assetCode, name: holding.assetName },
        ]),
      );

      const [pending, quotedAt] = await Promise.all([
        listPendingAllocations(walletDeps, userId),
        port.latestQuoteAt([...assetLabels.keys()]),
      ]);

      return {
        summary: buildDashboardSummary({
          query: query.value,
          quotedAt,
          delayMinutes: delayMinutes.value,
          lastImportAt,
          thresholdDays: thresholdDays.value,
          today,
          reconciliation: latestReconciliation(committed),
          pending,
          unclassified,
          assetLabels,
        }),
      };
    },
    db,
  );
}
