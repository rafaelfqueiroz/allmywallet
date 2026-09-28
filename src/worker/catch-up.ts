import { logger } from '@/lib/logger';
import { db as globalDb, type Database } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { computePollingSet } from '@/core/quotes/polling-set';
import { enumerateCatchUpDays } from '@/core/quotes/catch-up-days';
import { syncOfficialCloses } from '@/core/quotes/sync-official-closes';
import type {
  AssetCatalogPort,
  Clock,
  CloseGapRepositoryPort,
  HeldAssetsPort,
  LatestCloseDatePort,
  OfficialCloseSource,
  QuoteRepositoryPort,
  TradingCalendar,
  UnofficialClosesPort,
} from '@/core/quotes/ports';
import { DrizzleHeldAssetsRepository } from '@/adapters/db/held-assets-repository';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import { buildOfficialCloseSource, buildQuotesComposition } from '@/worker/handlers/composition';
import { handleBcbSync } from '@/worker/handlers/bcb';
import { handleTesouroSync } from '@/worker/handlers/tesouro';
import { handleValuationSnapshot } from '@/worker/handlers/valuation';
import { QUEUE } from '@/worker/queues';

/** The market-series syncs catch-up runs itself, named by the queue that owns each. */
export type MarketSeriesQueue = typeof QUEUE.BCB_SYNC | typeof QUEUE.TESOURO_SYNC;

/**
 * SPEC-021 — missed-schedule catch-up (BR-021-28..33), rewritten onto
 * `syncOfficialCloses` for #171 (SPEC-008 BR-008-09/BR-008-30/BR-008-31): the
 * closes this recovers are B3's own COTAHIST, never brapi's.
 *
 * The personal instance runs on a laptop that is closed, asleep or off for
 * days at a time. pg-boss fires a cron at its next match, never retroactively,
 * so every `quotes.close-capture` that fell inside an absence is simply gone —
 * and a close is not recoverable by waiting (DL-021-03). This runs once on
 * worker start, **before** `startWorker` registers any cron (BR-021-28), so the
 * first scheduled snapshot of the day already rests on the recovered history.
 *
 * AR-04: a thin entrypoint. The window is `core/quotes/catch-up-days.ts`, the
 * recovery `core/quotes/sync-official-closes.ts` (the same use case
 * `quotes.close-capture` itself runs), the snapshot rebuild the existing
 * `valuation.snapshot` path; this file resolves ports and sequences.
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
  readonly repository: QuoteRepositoryPort &
    LatestCloseDatePort & {
      deleteClose(assetId: AssetId, date: BusinessDate): Promise<void>;
    };
  readonly heldAssets: HeldAssetsPort;
  /** SPEC-008 BR-008-30, DL-008-14 (#171) — B3's COTAHIST, the only source an official close is read from. */
  readonly closeSource: OfficialCloseSource;
  readonly gaps: CloseGapRepositoryPort;
  readonly unofficial: UnofficialClosesPort;
  /**
   * BR-021-29 — BCB and Tesouro backfill themselves; catch-up relies on that
   * rather than reimplementing it, and only makes sure it has happened before
   * the rebuild, so a recovered day's fixed-income accrual reads the CDI
   * published for it (BR-021-30).
   *
   * #161: run on **every** start, not only after a missed equity close. The
   * two schedules are independent — a laptop open at 17:05 and closed by
   * 18:30 captures every close and never runs `tesouro.sync` — so a start
   * that found no equity close missing may still find Tesouro days missing.
   * The Tesouro sync queues the snapshot rebuild for the days it fills
   * itself (`handlers/tesouro.ts`), so catch-up rebuilds only for the closes
   * it recovered.
   *
   * Resolves to the syncs that failed. Catch-up runs outside pg-boss, so it
   * has no retry of its own; the worker hands these to their queues once
   * they exist, and the queue's retry policy takes over (#123, BR-008-27).
   */
  readonly syncMarketSeries: () => Promise<readonly MarketSeriesQueue[]>;
  /** BR-021-30 — the existing `valuation.snapshot` rebuild-from-date path. */
  readonly rebuildSnapshotsFrom: (from: BusinessDate) => Promise<void>;
}

export interface CatchUpSummary {
  readonly days: readonly BusinessDate[];
  readonly beyondCap: number;
  readonly recovered: number;
  readonly superseded: number;
  readonly gaps: number;
  readonly unpublished: number;
  readonly requests: number;
  /** `null` when nothing was written or deleted, so nothing was rebuilt. */
  readonly rebuiltFrom: BusinessDate | null;
  /** The market-series syncs that failed, for the worker to enqueue. */
  readonly retryQueues: readonly MarketSeriesQueue[];
}

const NOTHING_MISSED: Omit<CatchUpSummary, 'retryQueues'> = {
  days: [],
  beyondCap: 0,
  recovered: 0,
  superseded: 0,
  gaps: 0,
  unpublished: 0,
  requests: 0,
  rebuiltFrom: null,
};

/**
 * Each sync guarded on its own: an unreachable BCB must not cost the rebuild
 * its Tesouro prices, and neither may stop the worker from starting.
 */
export async function runMarketSeriesSyncs(
  syncs: Readonly<Record<MarketSeriesQueue, () => Promise<void>>>,
): Promise<readonly MarketSeriesQueue[]> {
  const failed: MarketSeriesQueue[] = [];
  for (const queue of [QUEUE.BCB_SYNC, QUEUE.TESOURO_SYNC] as const) {
    try {
      await syncs[queue]();
    } catch (error) {
      logger.error({ queue: 'catch-up', sync: queue, err: error }, 'catch-up: market sync failed');
      failed.push(queue);
    }
  }
  return failed;
}

async function defaultSyncMarketSeries(): Promise<readonly MarketSeriesQueue[]> {
  return runMarketSeriesSyncs({
    [QUEUE.BCB_SYNC]: () => handleBcbSync(),
    [QUEUE.TESOURO_SYNC]: () => handleTesouroSync(),
  });
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
    heldAssets: overrides?.heldAssets ?? new DrizzleHeldAssetsRepository(database),
    closeSource: overrides?.closeSource ?? (await buildOfficialCloseSource(database)),
    gaps: overrides?.gaps ?? new DrizzleCloseGapRepository(database),
    unofficial: overrides?.unofficial ?? composition.repository,
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
  const captureTime = (await resolveConfig('quotes.close_capture_time', { db: deps.database }))
    .value;
  const annualFileMinDays = (
    await resolveConfig('quotes.cotahist_annual_min_days', { db: deps.database })
  ).value;

  // #171: `syncOfficialCloses`'s own supersede step (`UnofficialClosesPort`)
  // reaches every stored listed-asset close not from COTAHIST, any date, any
  // asset, held or not — not bounded by this run's window, and must run
  // whether or not the window found a day missed, and whether or not
  // anything is currently held (a supersede-only run costs one indexed query
  // and zero `OfficialCloseSource` requests when there is nothing to do).
  const pollingSetIds = await computePollingSet(deps);
  const window =
    pollingSetIds.length === 0
      ? { days: [], beyondCap: 0 }
      : enumerateCatchUpDays({
          calendar: deps.calendar,
          now: deps.clock.now(),
          today: deps.clock.today(),
          lastCapturedClose: await deps.repository.oldestLastCloseAmong(pollingSetIds),
          maxDays,
          captureTime,
        });
  const sync = await syncOfficialCloses(
    {
      source: deps.closeSource,
      repository: deps.repository,
      gaps: deps.gaps,
      unofficial: deps.unofficial,
    },
    await deps.catalog.findByIds(pollingSetIds),
    window.days,
    { annualFileMinDays, currentYear: Number(deps.clock.today().slice(0, 4)) },
  );

  // #161: every start, whether or not an equity close was missed — see
  // `syncMarketSeries`. After the equity sync, before the rebuild.
  const retryQueues = await deps.syncMarketSeries();

  if (window.days.length === 0 && sync.earliestChanged === null) {
    logger.info({ queue: 'catch-up', retryQueues }, 'catch-up: no close was missed');
    return { ...NOTHING_MISSED, retryQueues };
  }

  // BR-021-30: one rebuild from the earliest *changed* day forward — not
  // necessarily the window's first day: that day may have needed no write at
  // all (already captured from COTAHIST, or genuinely unpublished). The
  // snapshot engine walks dates ascending and each day's figures rest on the
  // day before, so a single call *is* "in date order"; a rebuild per day
  // would rewrite every later day once per earlier one for the same result.
  if (sync.earliestChanged !== null) {
    await deps.rebuildSnapshotsFrom(sync.earliestChanged);
  }

  const summary: CatchUpSummary = {
    days: window.days,
    beyondCap: window.beyondCap,
    recovered: sync.recorded.length,
    superseded: sync.superseded.length,
    gaps: sync.gaps.length,
    unpublished: sync.unpublished,
    requests: sync.requests,
    rebuiltFrom: sync.earliestChanged,
    retryQueues,
  };
  // AR-39: dates and counts only — no asset, no figure.
  logger.info({ queue: 'catch-up', ...summary }, 'catch-up complete');
  return summary;
}
