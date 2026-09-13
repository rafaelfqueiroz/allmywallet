import { logger } from '@/lib/logger';
import { db as globalDb, type Database } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import type { BusinessDate } from '@/core/shared/clock';
import { computePollingSet } from '@/core/quotes/polling-set';
import { enumerateCatchUpDays } from '@/core/quotes/catch-up-days';
import { backfillMissedCloses } from '@/core/quotes/backfill-missed-closes';
import type {
  AssetCatalogPort,
  BudgetCounterPort,
  Clock,
  CloseGapRepositoryPort,
  HeldAssetsPort,
  LatestCloseDatePort,
  QuoteProvider,
  QuoteRepositoryPort,
  TradingCalendar,
} from '@/core/quotes/ports';
import { DrizzleHeldAssetsRepository } from '@/adapters/db/held-assets-repository';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import {
  buildQuoteProvider,
  buildQuotesComposition,
  resolveQuoteBudgetConfig,
} from '@/worker/handlers/composition';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { handleTesouroSync } from '@/worker/handlers/tesouro';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';

/**
 * SPEC-021 — missed-schedule catch-up (BR-021-28..33).
 *
 * The personal instance runs on a laptop that is closed, asleep or off for
 * days at a time. pg-boss fires a cron at its next match, never retroactively,
 * so every `quotes.close-capture` that fell inside an absence is simply gone —
 * and a close is not recoverable by waiting (DL-021-03). This runs once on
 * worker start, **before** `startWorker` registers any cron (BR-021-28), so the
 * first scheduled snapshot of the day already rests on the recovered history.
 *
 * AR-04: a thin entrypoint. The window is `core/quotes/catch-up-days.ts`, the
 * recovery `core/quotes/backfill-missed-closes.ts`, the snapshot rebuild the
 * existing `valuation.snapshot` path; this file resolves ports and sequences.
 *
 * **What it deliberately does not do (BR-021-33).** It never enqueues
 * `opportunity.evaluate`, holds no notifier, and never writes `latest_quotes`.
 * There is no dependency below through which it could.
 */
export interface CatchUpDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly calendar: TradingCalendar;
  readonly catalog: AssetCatalogPort;
  readonly repository: QuoteRepositoryPort & LatestCloseDatePort;
  readonly budgetCounter: BudgetCounterPort;
  readonly heldAssets: HeldAssetsPort;
  readonly provider: QuoteProvider;
  readonly gaps: CloseGapRepositoryPort;
  /**
   * BR-021-29 — BCB and Tesouro already backfill from their latest stored
   * value; catch-up relies on that rather than reimplementing it, and only
   * makes sure it has happened before the rebuild, so a recovered day's
   * fixed-income accrual reads the CDI published for it (BR-021-30).
   */
  readonly syncMarketSeries: () => Promise<void>;
  /** BR-021-30 — the existing `valuation.snapshot` rebuild-from-date path. */
  readonly rebuildSnapshotsFrom: (from: BusinessDate) => Promise<void>;
}

export interface CatchUpSummary {
  readonly days: readonly BusinessDate[];
  readonly beyondCap: number;
  readonly recovered: number;
  readonly gaps: number;
  readonly requests: number;
  /** `null` when nothing was missed, so nothing was rebuilt. */
  readonly rebuiltFrom: BusinessDate | null;
}

const NOTHING_MISSED: CatchUpSummary = {
  days: [],
  beyondCap: 0,
  recovered: 0,
  gaps: 0,
  requests: 0,
  rebuiltFrom: null,
};

async function defaultSyncMarketSeries(): Promise<void> {
  // Each guarded on its own: an unreachable BCB must not cost the rebuild its
  // Tesouro prices, and neither may stop the worker from starting.
  try {
    await handleBcbSync();
  } catch (error) {
    logger.error({ queue: 'catch-up', err: error }, 'catch-up: bcb.sync failed');
  }
  try {
    await handleTesouroSync();
  } catch (error) {
    logger.error({ queue: 'catch-up', err: error }, 'catch-up: tesouro.sync failed');
  }
}

async function resolveDeps(overrides?: Partial<CatchUpDeps>): Promise<CatchUpDeps> {
  const database = overrides?.database ?? globalDb;
  const composition = buildQuotesComposition(database);
  const clock = overrides?.clock ?? composition.clock;
  const calendar = overrides?.calendar ?? composition.calendar;
  return {
    database,
    clock,
    calendar,
    catalog: overrides?.catalog ?? composition.catalog,
    repository: overrides?.repository ?? composition.repository,
    budgetCounter: overrides?.budgetCounter ?? composition.budgetCounter,
    heldAssets: overrides?.heldAssets ?? new DrizzleHeldAssetsRepository(database),
    provider: overrides?.provider ?? (await buildQuoteProvider(database)),
    gaps: overrides?.gaps ?? new DrizzleCloseGapRepository(database),
    syncMarketSeries: overrides?.syncMarketSeries ?? defaultSyncMarketSeries,
    rebuildSnapshotsFrom:
      overrides?.rebuildSnapshotsFrom ??
      (async (from) => {
        await handleValuationSnapshot({ from }, { database, clock, calendar });
      }),
  };
}

export async function runCatchUp(overrides?: Partial<CatchUpDeps>): Promise<CatchUpSummary> {
  const deps = await resolveDeps(overrides);

  // Config first, before anything below opens a tenant transaction on the
  // pool: `resolveConfig` reads `config_overrides` bare (no tenant), and a
  // pooled connection that has run `withTenant` is left with an empty
  // `app.user_id` that makes that read fail (the defect documented in
  // tests/integration/opportunity-worker-handler.test.ts).
  const maxDays = (await resolveConfig('personal.catchup_max_days', { db: deps.database })).value;
  const { monthlyQuota, ondemandReservePct } = await resolveQuoteBudgetConfig(deps.database);

  const pollingSetIds = await computePollingSet(deps);
  if (pollingSetIds.length === 0) {
    logger.info({ queue: 'catch-up' }, 'catch-up: nothing held is polled, nothing to recover');
    return NOTHING_MISSED;
  }

  const window = enumerateCatchUpDays({
    calendar: deps.calendar,
    now: deps.clock.now(),
    today: deps.clock.today(),
    lastCapturedClose: await deps.repository.latestCloseDateAmong(pollingSetIds),
    maxDays,
  });
  const first = window.days[0];
  if (first === undefined) {
    logger.info({ queue: 'catch-up' }, 'catch-up: no close was missed');
    return NOTHING_MISSED;
  }

  const assets = await deps.catalog.findByIds(pollingSetIds);
  const backfill = await backfillMissedCloses(deps, assets, window.days, {
    monthlyQuota,
    ondemandReservePct,
  });

  await deps.syncMarketSeries();
  // BR-021-30: one rebuild from the earliest missed day forward. The snapshot
  // engine walks dates ascending and each day's figures rest on the day
  // before, so a single call *is* "in date order"; a rebuild per day would
  // rewrite every later day once per earlier one for the same result.
  await deps.rebuildSnapshotsFrom(first);

  const summary: CatchUpSummary = {
    days: window.days,
    beyondCap: window.beyondCap,
    recovered: backfill.recovered.length,
    gaps: backfill.gaps.length,
    requests: backfill.requests,
    rebuiltFrom: first,
  };
  // AR-39: dates and counts only — no asset, no figure.
  logger.info({ queue: 'catch-up', ...summary }, 'catch-up complete');
  return summary;
}
