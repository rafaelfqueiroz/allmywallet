import { logger } from '@/lib/logger';
import { db as globalDb, type Database } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import type { BusinessDate } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { computePollingSet } from '@/core/quotes/polling-set';
import { pollHeldAsset } from '@/core/quotes/poll-held-asset';
import { enumerateCatchUpDays } from '@/core/quotes/catch-up-days';
import { syncOfficialCloses } from '@/core/quotes/sync-official-closes';
import { DrizzleHeldAssetsRepository } from '@/adapters/db/held-assets-repository';
import { DrizzleCloseGapRepository } from '@/adapters/db/close-gap-repository';
import type {
  AssetCatalogPort,
  BudgetCounterPort,
  Clock,
  CloseGapRepositoryPort,
  HeldAssetsPort,
  LatestCloseDatePort,
  OfficialCloseSource,
  QuoteProvider,
  QuoteRepositoryPort,
  TradingCalendar,
  UnofficialClosesPort,
} from '@/core/quotes/ports';
import { enqueue } from '@/lib/queue';
import { QUEUE } from '@/worker/queues';
import type { OpportunityEvaluateJobPayload } from '@/worker/handlers/opportunity';
import type { SnapshotJobPayload } from '@/worker/handlers/valuation';
import {
  buildOfficialCloseSource,
  buildQuoteProvider,
  buildQuotesComposition,
  resolveQuoteBudgetConfig,
} from './composition';

/**
 * Every field is optional and defaults to the real (Postgres/System/HTTP)
 * composition — this seam exists so an integration test can swap in a
 * `FakeClock`/`FakeTradingCalendar`/`FakeHeldAssetsPort`/`FakeQuoteProvider`
 * while still exercising `AssetCatalogPort`/`QuoteRepositoryPort`/
 * `BudgetCounterPort` against real Postgres (Testcontainers) — exactly what
 * "assert zero provider calls over a simulated weekend" (this spec's own
 * Test plan) needs: a controllable clock/calendar/held-set feeding a real
 * database. It is not a job payload (AR-21 governs those; this handler
 * takes none) and is never populated by pg-boss.
 *
 * `database` is separate from `repository`/`catalog`/`budgetCounter`: it is
 * what `resolveQuoteBudgetConfig`/`buildQuoteProvider` read config through.
 * Without overriding it too, a test that swaps every *port* but not this
 * would still have config resolution silently reconnect to
 * `env().DATABASE_URL` instead of the test's own database.
 */
export interface QuotesHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly calendar: TradingCalendar;
  readonly catalog: AssetCatalogPort;
  /**
   * SPEC-008 BR-008-09/BR-021-28 (#171) — `handleQuotesCloseCapture` also
   * needs `oldestLastCloseAmong` (the same window `runCatchUp` computes) and
   * `deleteClose` (a close COTAHIST no longer supplies must not stay in
   * history) — both are `DrizzleQuoteRepository` methods already.
   */
  readonly repository: QuoteRepositoryPort &
    LatestCloseDatePort & {
      deleteClose(assetId: AssetId, date: BusinessDate): Promise<void>;
    };
  readonly budgetCounter: BudgetCounterPort;
  readonly heldAssets: HeldAssetsPort;
  readonly provider: QuoteProvider;
  /** SPEC-008 BR-008-30, DL-008-14 (#171) — B3's COTAHIST, the only source an official close is read from. */
  readonly closeSource: OfficialCloseSource;
  readonly gaps: CloseGapRepositoryPort;
  readonly unofficial: UnofficialClosesPort;
  /**
   * SPEC-009 BR-009-18 (#171) — the 19:40 `valuation.snapshot` cron now runs
   * *before* the close job (`quotes.close_capture_time` defaults to 22:00, see
   * `src/config/registry.ts`), so the rebuild the close job's own writes
   * invalidate can no longer rely on that cron catching them — it must be
   * enqueued here, the same shape as `tesouro.ts`'s `enqueueSnapshotRebuild`.
   */
  readonly enqueueSnapshotRebuild: (from: BusinessDate) => Promise<void>;
  /**
   * SPEC-018 BR-018-11 — how `quotes.poll` asks for the assets it just polled
   * to be evaluated. A seam rather than a direct `enqueue` call, the same
   * shape as `ImportHandlerDeps.enqueueSnapshot`
   * (`src/worker/handlers/import.ts`), so an integration test can assert
   * *that* an evaluation was requested and for *which* assets without
   * standing up pg-boss — and, just as importantly, assert it was **not**
   * called when nothing was polled.
   */
  readonly enqueueOpportunityEvaluation: (payload: OpportunityEvaluateJobPayload) => Promise<void>;
}

interface ResolvedQuotesDeps extends Omit<QuotesHandlerDeps, 'database'> {
  readonly resolveConfigWith: Database | undefined;
}

async function resolveDeps(overrides?: Partial<QuotesHandlerDeps>): Promise<ResolvedQuotesDeps> {
  const database = overrides?.database;
  const composition = buildQuotesComposition(database);
  return {
    // Kept possibly-`undefined` (rather than defaulted to `globalDb` here) so
    // `resolveQuoteBudgetConfig`/`buildQuoteProvider`/`buildOfficialCloseSource`
    // fall back to their own default the same way whether this handler is
    // given no override at all, or a test overrides every *port* but not
    // `database` itself.
    resolveConfigWith: database,
    clock: overrides?.clock ?? composition.clock,
    calendar: overrides?.calendar ?? composition.calendar,
    catalog: overrides?.catalog ?? composition.catalog,
    repository: overrides?.repository ?? composition.repository,
    budgetCounter: overrides?.budgetCounter ?? composition.budgetCounter,
    heldAssets: overrides?.heldAssets ?? new DrizzleHeldAssetsRepository(database),
    provider: overrides?.provider ?? (await buildQuoteProvider(database)),
    closeSource: overrides?.closeSource ?? (await buildOfficialCloseSource(database)),
    gaps: overrides?.gaps ?? new DrizzleCloseGapRepository(database ?? globalDb),
    unofficial: overrides?.unofficial ?? composition.repository,
    enqueueSnapshotRebuild:
      overrides?.enqueueSnapshotRebuild ??
      ((from) => enqueue(QUEUE.VALUATION_SNAPSHOT, { from } satisfies SnapshotJobPayload)),
    enqueueOpportunityEvaluation:
      overrides?.enqueueOpportunityEvaluation ??
      ((payload) => enqueue(QUEUE.OPPORTUNITY_EVALUATE, payload)),
  };
}

/**
 * SPEC-008 `quotes.poll` — AR-18: the trading-calendar check lives **here**,
 * not in the cron expression, because cron cannot express B3 holidays or
 * half-sessions (BR-008-06). The cron fires every few minutes regardless of
 * the effective cadence; `pollHeldAsset`'s own "already fresh" check
 * (AR-19) is what actually throttles real provider calls to
 * `quotes.cadence_minutes`.
 */
export async function handleQuotesPoll(overrides?: Partial<QuotesHandlerDeps>): Promise<void> {
  const {
    clock,
    calendar,
    catalog,
    repository,
    budgetCounter,
    heldAssets,
    provider,
    resolveConfigWith,
    enqueueOpportunityEvaluation,
  } = await resolveDeps(overrides);

  if (!calendar.isSessionOpen(clock.now())) {
    // BR-008-06: outside the session, zero requests — not even a "checked and skipped" call.
    return;
  }

  const pollingSetIds = await computePollingSet({ heldAssets, catalog });
  if (pollingSetIds.length === 0) return;

  const assets = await catalog.findByIds(pollingSetIds);
  const { cadenceMinutes, monthlyQuota, ondemandReservePct } =
    await resolveQuoteBudgetConfig(resolveConfigWith);

  let polled = 0;
  let skippedBudget = 0;
  let failed = 0;
  /*
   * SPEC-018 BR-018-11/DL-018-04 — the assets that have a usable stored quote
   * after this cycle: the ones just polled, **and** the ones that were
   * already fresh.
   *
   * The `already_fresh` half is not padding, it is what makes a retry able to
   * recover. `pollHeldAsset` is idempotent by reporting `already_fresh` for
   * an asset polled inside the current cadence window (AR-19) — which is what
   * stops a retry double-spending budget, and precisely what used to make a
   * retry *lossy* here. If the enqueue below failed after the quotes were
   * written and committed, pg-boss re-entered this handler, every asset came
   * back `already_fresh`, the polled list was empty, and that cycle's quote
   * write was never evaluated by anybody. A crossing inside it was gone — the
   * one signal BR-018-11 hangs the whole feature on.
   *
   * Enqueueing the fresh ones too costs nothing that matters:
   * `evaluateOpportunities` issues no provider request by construction
   * (`core/opportunity/dependencies.ts`) and is idempotent over an
   * observation it has already seen (DL-018-08), so a re-evaluation of an
   * unchanged quote decides "unchanged" and sends nothing.
   *
   * `skipped_budget` and `failed` assets stay out: whatever is stored for
   * them is what the previous cycle already evaluated, and nothing about them
   * changed.
   */
  const evaluatableAssetIds: string[] = [];
  for (const asset of assets) {
    const result = await pollHeldAsset({ repository, provider, budgetCounter, clock }, asset, {
      cadenceMinutes,
      monthlyQuota,
      ondemandReservePct,
    });
    if (result.outcome === 'polled') {
      polled += 1;
      evaluatableAssetIds.push(asset.id);
    } else if (result.outcome === 'already_fresh') {
      evaluatableAssetIds.push(asset.id);
    } else if (result.outcome === 'skipped_budget') skippedBudget += 1;
    else if (result.outcome === 'failed') failed += 1;
  }

  if (evaluatableAssetIds.length > 0) {
    await enqueueOpportunityEvaluation({ assetIds: evaluatableAssetIds });
  }

  logger.info(
    { queue: 'quotes.poll', assetCount: assets.length, polled, skippedBudget, failed },
    'quotes.poll cycle complete',
  );
  // BR-008-27: persistent failure is visible via this log and pg-boss's own
  // retry/dead-letter policy (src/worker/queues.ts) — not retried in a loop here.
}

/**
 * SPEC-008 `quotes.close-capture` — BR-008-09/BR-008-30/BR-008-31, DL-008-08,
 * DL-008-14 (#171). Official closes come from B3's COTAHIST, never from
 * `provider` (the intraday quote provider is not read by this handler at
 * all) — `syncOfficialCloses` is the shared use case this and worker-start
 * catch-up (`src/worker/catch-up.ts`) both run.
 *
 * No `isTradingDay` early return: the window below decides what is due,
 * including a day this run's own cron missed (the cron now fires daily at
 * `quotes.close_capture_time`, not "weekdays at 17:05" — see
 * `closeCaptureCron`). Config is resolved **before** any tenant transaction
 * opens on the pool — see the comment in `src/worker/catch-up.ts` about
 * config reads on a pooled connection; this handler opens none itself, but
 * shares the composition root and the same caution applies.
 */
export async function handleQuotesCloseCapture(
  overrides?: Partial<QuotesHandlerDeps>,
): Promise<void> {
  const {
    clock,
    calendar,
    catalog,
    repository,
    heldAssets,
    closeSource,
    gaps,
    unofficial,
    resolveConfigWith,
    enqueueSnapshotRebuild,
  } = await resolveDeps(overrides);

  const configDb = resolveConfigWith ?? globalDb;
  const captureTime = (await resolveConfig('quotes.close_capture_time', { db: configDb })).value;
  const maxDays = (await resolveConfig('personal.catchup_max_days', { db: configDb })).value;
  const annualFileMinDays = (
    await resolveConfig('quotes.cotahist_annual_min_days', { db: configDb })
  ).value;

  // #171: `syncOfficialCloses`'s own supersede step (`UnofficialClosesPort`)
  // reaches every stored listed-asset close not from COTAHIST, *any* date,
  // *any* asset, held or not — it is not bounded by this run's window and
  // must run whether or not the window itself found a day due, and whether
  // or not anything is currently held (the AC: every close in history equals
  // COTAHIST's, none sourced from an intraday quote — that must keep holding
  // even for an asset since sold). So this never returns early on an empty
  // polling set or an empty window; the cost of a no-op run is one indexed
  // query and zero `OfficialCloseSource` requests.
  const pollingSetIds = await computePollingSet({ heldAssets, catalog });
  const assets = await catalog.findByIds(pollingSetIds);
  const window =
    pollingSetIds.length === 0
      ? { days: [], beyondCap: 0 }
      : enumerateCatchUpDays({
          calendar,
          now: clock.now(),
          today: clock.today(),
          lastCapturedClose: await repository.oldestLastCloseAmong(pollingSetIds),
          maxDays,
          captureTime,
        });

  const currentYear = Number(clock.today().slice(0, 4));
  const summary = await syncOfficialCloses(
    { source: closeSource, repository, gaps, unofficial },
    assets,
    window.days,
    { annualFileMinDays, currentYear },
  );

  if (summary.earliestChanged !== null) {
    await enqueueSnapshotRebuild(summary.earliestChanged);
  }

  logger.info(
    {
      queue: 'quotes.close-capture',
      assetCount: assets.length,
      days: window.days.length,
      beyondCap: window.beyondCap,
      recorded: summary.recorded.length,
      superseded: summary.superseded.length,
      removed: summary.removed.length,
      gaps: summary.gaps.length,
      unpublished: summary.unpublished,
      requests: summary.requests,
      rebuildFrom: summary.earliestChanged,
    },
    'quotes.close-capture cycle complete',
  );
}
