import { logger } from '@/lib/logger';
import type { Database } from '@/db/client';
import { computePollingSet } from '@/core/quotes/polling-set';
import { pollHeldAsset } from '@/core/quotes/poll-held-asset';
import { captureClosePrice } from '@/core/quotes/capture-close-price';
import { DrizzleHeldAssetsRepository } from '@/adapters/db/held-assets-repository';
import type {
  AssetCatalogPort,
  BudgetCounterPort,
  Clock,
  HeldAssetsPort,
  QuoteProvider,
  QuoteRepositoryPort,
  TradingCalendar,
} from '@/core/quotes/ports';
import { enqueue } from '@/lib/queue';
import { QUEUE } from '@/worker/queues';
import type { OpportunityEvaluateJobPayload } from '@/worker/handlers/opportunity';
import {
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
  readonly repository: QuoteRepositoryPort;
  readonly budgetCounter: BudgetCounterPort;
  readonly heldAssets: HeldAssetsPort;
  readonly provider: QuoteProvider;
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
    resolveConfigWith: database,
    clock: overrides?.clock ?? composition.clock,
    calendar: overrides?.calendar ?? composition.calendar,
    catalog: overrides?.catalog ?? composition.catalog,
    repository: overrides?.repository ?? composition.repository,
    budgetCounter: overrides?.budgetCounter ?? composition.budgetCounter,
    heldAssets: overrides?.heldAssets ?? new DrizzleHeldAssetsRepository(database),
    provider: overrides?.provider ?? (await buildQuoteProvider(database)),
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
 * SPEC-008 `quotes.close-capture` — BR-008-09/DL-008-08: the one deliberate
 * call outside session hours. AR-18: the handler still checks
 * `isTradingDay` itself, since the cron schedule (weekdays) cannot express
 * B3 holidays.
 */
export async function handleQuotesCloseCapture(
  overrides?: Partial<QuotesHandlerDeps>,
): Promise<void> {
  const { clock, calendar, catalog, repository, budgetCounter, heldAssets, provider } =
    await resolveDeps(overrides);

  const today = clock.today();
  if (!calendar.isTradingDay(today)) {
    return;
  }

  const pollingSetIds = await computePollingSet({ heldAssets, catalog });
  if (pollingSetIds.length === 0) return;

  const assets = await catalog.findByIds(pollingSetIds);

  let captured = 0;
  let alreadyCaptured = 0;
  let failed = 0;
  for (const asset of assets) {
    const result = await captureClosePrice({ repository, provider, budgetCounter, clock }, asset);
    if (result.outcome === 'captured') captured += 1;
    else if (result.outcome === 'already_captured') alreadyCaptured += 1;
    else failed += 1;
  }

  logger.info(
    { queue: 'quotes.close-capture', assetCount: assets.length, captured, alreadyCaptured, failed },
    'quotes.close-capture cycle complete',
  );
}
