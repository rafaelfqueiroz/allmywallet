import { logger } from '@/lib/logger';
import { db as globalDb, type Database } from '@/db/client';
import { users } from '@/db/schema/users';
import { withTenant, type Tx } from '@/db/tenant';
import { BusinessDate, SystemClock, type Clock } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';
import type { Transaction } from '@/core/ledger/transaction';
import type { TradingCalendar } from '@/core/quotes/ports';
import type {
  FixedIncomeContractPort,
  IndexSeriesReaderPort,
  PriceHistoryPort,
  SnapshotRepositoryPort,
} from '@/core/valuation/ports';
import { computeSnapshots, earliestTradeDate, persistSnapshots } from '@/core/valuation/snapshot';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleFixedIncomeContractReader } from '@/adapters/db/fixed-income-contract-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { DrizzleValuationSnapshotRepository } from '@/adapters/db/valuation-snapshot-repository';

/**
 * SPEC-009 — `valuation.snapshot` and `fixedincome.accrue`.
 *
 * AR-04: thin entrypoints. Every rule lives in `core/valuation/`; this file
 * resolves ports to adapters, walks the tenants and logs.
 *
 * **Tenant handling** (ARCHITECTURE §5's worker caveat). A background job has
 * no session, so it carries the `userId` explicitly and calls `withTenant` per
 * tenant. The tenant list itself comes from `users`, which is deliberately not
 * RLS-scoped (it is the root every policy references) — reading it is the one
 * cross-tenant step, and it reads ids only.
 *
 * **Why there is no `fixed_income_accruals` table.** Accrual is a pure
 * function of the contract, the published index series and the trading
 * calendar. Persisting the accrued value would create a second source of
 * truth that could disagree with a recomputation — precisely what BR-009-17
 * forbids for snapshots, and for the same reason. `fixedincome.accrue`
 * therefore *materialises* the day's accrual into the snapshot rather than
 * into a store of its own. See the dispatch report.
 */

export interface ValuationHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly calendar: TradingCalendar;
  readonly prices: PriceHistoryPort;
  readonly indexSeries: IndexSeriesReaderPort;
  /**
   * SPEC-005 (#8) owns `fixed_income_contracts`. Left `undefined` here on
   * purpose rather than defaulted eagerly in `resolveDeps`: the real adapter
   * (`DrizzleFixedIncomeContractReader`) must be tenant-scoped per lookup
   * (`fixed_income_contracts` is `FORCE`d RLS), and `resolveDeps` builds one
   * `deps` object shared across every tenant in the run — there is no single
   * `userId` to construct it with at that point. `rebuildTenant` below
   * constructs the real, per-tenant instance when this is left unset; tests
   * inject a fake here directly, tenant-agnostic, which is what every
   * existing SPEC-009 test already does and is untouched by this change.
   */
  readonly contracts?: FixedIncomeContractPort | undefined;
  /** Built per tenant, inside `withTenant` — hence a factory, not an instance. */
  readonly snapshotsFor: (tx: Tx, userId: UserId) => SnapshotRepositoryPort;
  readonly transactionsFor: (
    tx: Tx,
    userId: UserId,
  ) => { listAll(): Promise<readonly Transaction[]> };
}

function resolveDeps(overrides?: Partial<ValuationHandlerDeps>): ValuationHandlerDeps {
  const database = overrides?.database ?? globalDb;
  return {
    database,
    clock: overrides?.clock ?? new SystemClock(),
    calendar: overrides?.calendar ?? new B3TradingCalendar(),
    prices: overrides?.prices ?? new DrizzleQuoteRepository(database),
    indexSeries: overrides?.indexSeries ?? new DrizzleIndexSeriesRepository(database),
    // BR-009-13: left unset when not overridden — `rebuildTenant` constructs
    // the real, tenant-scoped `DrizzleFixedIncomeContractReader` per tenant.
    // A position with no contract still values honestly either way (at cost,
    // flagged for "Needs attention"): that behaviour lives in
    // `core/valuation/snapshot.ts` and does not change with this wiring.
    contracts: overrides?.contracts,
    snapshotsFor:
      overrides?.snapshotsFor ??
      ((tx, userId) => new DrizzleValuationSnapshotRepository(tx, userId)),
    transactionsFor:
      overrides?.transactionsFor ?? ((tx, userId) => new DrizzleTransactionRepository(tx, userId)),
  };
}

/** Tenant ids only. The one cross-tenant read a valuation job performs. */
async function listTenantIds(database: Database): Promise<readonly UserId[]> {
  const rows = await database.select({ id: users.id }).from(users);
  return rows.map((row) => UserId.of(row.id));
}

export interface SnapshotJobPayload {
  /**
   * BR-009-18 / AC-15: a backdated edit rebuilds **from that date forward**,
   * not just today. The write path puts the edited transaction's trade date
   * here. Absent means "rebuild this tenant's whole history", which is what a
   * first run and a manual backfill both want.
   *
   * AR-21: a `YYYY-MM-DD` string, not a `Date` — the payload is JSON.
   */
  readonly from?: string;
  /** Restricts the run to one tenant. Absent means every tenant. */
  readonly userId?: string;
}

export interface SnapshotRunSummary {
  readonly tenants: number;
  readonly snapshots: number;
  readonly failures: number;
}

/**
 * Rebuilds `[from, today]` for one tenant, inside a single `withTenant`
 * transaction (AR-11/AR-13) so the delete-then-write is atomic: a crash
 * between the two cannot leave a tenant with a hole in their history.
 */
async function rebuildTenant(
  deps: ValuationHandlerDeps,
  userId: UserId,
  today: BusinessDate,
  requestedFrom: BusinessDate | undefined,
): Promise<number> {
  // 1. Read the ledger under tenant context. RLS scopes it; nothing else in
  //    this transaction touches the pool, so it closes immediately.
  const ledger = await withTenant(
    userId,
    async (tx) => deps.transactionsFor(tx, userId).listAll(),
    deps.database,
  );

  const earliest = earliestTradeDate(ledger);
  // A tenant with no transactions has no snapshots — a different state from
  // "snapshots that are all zero", and the chart says so.
  if (earliest === null) return 0;

  // Never start before the ledger does: a `from` earlier than the first trade
  // would write a run of zero-valued days that never existed, which reads on
  // the chart as a flat line the user never had.
  const from =
    requestedFrom === undefined || BusinessDate.isBefore(requestedFrom, earliest)
      ? earliest
      : requestedFrom;
  if (BusinessDate.isAfter(from, today)) return 0;

  // 2. Compute with **no transaction open** for the shared reference tables
  //    (AR-15) this also reads — holding the tenant connection across a
  //    potentially multi-year computation would tie up a pooled connection
  //    for no reason. `fixed_income_contracts` is the one exception:
  //    tenant-scoped and FORCE-RLS'd, so `DrizzleFixedIncomeContractReader`
  //    opens its own short `withTenant` per lookup rather than needing one
  //    held open around the whole computation (see that class's own comment).
  const contracts = deps.contracts ?? new DrizzleFixedIncomeContractReader(deps.database, userId);
  const computed = await computeSnapshots(
    {
      calendar: deps.calendar,
      prices: deps.prices,
      contracts,
      indexSeries: deps.indexSeries,
      assets: new DrizzleAssetCatalogRepository(deps.database),
    },
    ledger,
    // BR-009-02: only today may consult an intraday quote. Every earlier date
    // in the range is history and reads closes only.
    { from, to: today, currentDate: today },
  );
  if (!computed.ok) {
    // A ledger the engine cannot process is a real condition, not a blip:
    // surfaced with its code, and nothing is written.
    throw new Error(`valuation failed for tenant: ${computed.error.code}`);
  }

  // 3. Write under tenant context, delete-then-insert in one transaction so a
  //    crash between them cannot leave a hole in the history.
  await withTenant(
    userId,
    async (tx) => persistSnapshots(deps.snapshotsFor(tx, userId), computed.value, from),
    deps.database,
  );
  return computed.value.length;
}

/**
 * SPEC-009 `valuation.snapshot` — BR-009-16/18.
 *
 * AR-19: idempotent. The rebuild is `DELETE FROM date` followed by an upsert
 * keyed `(user_id, date)`, both inside one transaction, so a retried job
 * produces exactly the rows the first attempt would have — never a duplicate
 * and never a doubled total.
 *
 * A failing tenant does not abort the run. One tenant's unprocessable ledger
 * must not cost every other tenant their snapshot for the day; the failure is
 * logged and counted, and pg-boss's own retry/dead-letter policy
 * (`src/worker/queues.ts`) is what makes it visible rather than a loop here.
 */
export async function handleValuationSnapshot(
  payload?: SnapshotJobPayload,
  overrides?: Partial<ValuationHandlerDeps>,
): Promise<SnapshotRunSummary> {
  const deps = resolveDeps(overrides);
  const today = deps.clock.today();
  const requestedFrom = payload?.from === undefined ? undefined : BusinessDate.of(payload.from);

  const tenantIds =
    payload?.userId === undefined
      ? await listTenantIds(deps.database)
      : [UserId.of(payload.userId)];

  let snapshots = 0;
  let failures = 0;
  for (const userId of tenantIds) {
    try {
      snapshots += await rebuildTenant(deps, userId, today, requestedFrom);
    } catch (error) {
      failures += 1;
      // AR-39/BR-004-04: the tenant id is a UUID, not personal data, and no
      // figure from the portfolio is logged.
      logger.error(
        { queue: 'valuation.snapshot', userId, err: error },
        'valuation.snapshot failed for tenant',
      );
    }
  }

  logger.info(
    { queue: 'valuation.snapshot', tenants: tenantIds.length, snapshots, failures, today },
    'valuation.snapshot cycle complete',
  );
  return { tenants: tenantIds.length, snapshots, failures };
}

/**
 * SPEC-009 `fixedincome.accrue` — BR-009-14.
 *
 * "Accrual runs once daily. Fixed income has no intraday behaviour." The
 * accrued carrying value is not stored anywhere of its own (see the file
 * header), so this job's work *is* refreshing today's snapshot — the surface
 * where the accrued figure actually reaches a report.
 *
 * AR-18: the trading-calendar check lives here rather than in the cron
 * expression, because cron cannot express B3 holidays. Skipping a non-trading
 * day is correct and not merely an optimisation: no new CDI is published, so a
 * re-run would recompute an identical figure.
 */
export async function handleFixedIncomeAccrue(
  overrides?: Partial<ValuationHandlerDeps>,
): Promise<SnapshotRunSummary> {
  const deps = resolveDeps(overrides);
  const today = deps.clock.today();

  if (!deps.calendar.isTradingDay(today)) {
    logger.info(
      { queue: 'fixedincome.accrue', today },
      'fixedincome.accrue: not a trading day, nothing accrues',
    );
    return { tenants: 0, snapshots: 0, failures: 0 };
  }

  // Only today is rebuilt: yesterday's accrual is already correct and
  // recomputing five years of it daily would be work with no output.
  return handleValuationSnapshot({ from: today }, overrides);
}
