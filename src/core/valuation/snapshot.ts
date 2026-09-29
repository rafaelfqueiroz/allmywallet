import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, TransactionId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { ok, type Result } from '@/core/shared/result';
import Decimal from 'decimal.js';
import { computeTotalValue, isEarnings, type Transaction } from '@/core/ledger/transaction';
import { aggregateAcrossInstitutions } from '@/core/positions/aggregate';
import { type AmortizationTerms, amortizationTermsOf } from '@/core/positions/amortization';
import { costsCarriedOut } from '@/core/positions/carried-out';
import { replayPositions } from '@/core/positions/replay';
import type { Asset, AssetCatalogPort } from '@/core/quotes/ports';
import { listCalendarDays } from '@/core/valuation/business-days';
import type { ListedValuationMode } from '@/core/valuation/listed';
import { FIXED_INCOME_CLASSES, valueHoldingsAt, type Holding } from '@/core/valuation/holdings';
import {
  type AssetClass,
  type DailyValuationSnapshot,
  type FixedIncomeContract,
  type FixedIncomeContractPort,
  type IndexSeriesReaderPort,
  type LatestQuote,
  type PriceHistoryPort,
  type PriceQuote,
  type SerializedSnapshot,
  type SnapshotRepositoryPort,
  type TradingCalendar,
  type ValuationContext,
  type ValuedPosition,
} from '@/core/valuation/ports';

// Moved to `ports.ts` so `holdings.ts` and this file can share it without a
// cycle. Re-exported because callers across the codebase import it from here.
export type { ValuationContext };

/**
 * SPEC-009 BR-009-16..19 — the daily valuation snapshot.
 *
 * **What a snapshot is for** (DL-009-06): computing five years of portfolio
 * value on demand cannot meet SPEC-016's report budget, so the figures are
 * persisted. **What a snapshot is not** (BR-009-17): authoritative. Every row
 * is reproducible from the ledger, the price history and the index series, and
 * where a stored snapshot disagrees with recomputation **the ledger wins**.
 * Nothing in this file increments a stored figure; a snapshot is only ever
 * overwritten with a freshly derived one.
 *
 * **BR-009-18 / AC-15**: editing a transaction dated two years ago invalidates
 * every snapshot from that date forward and rebuilds them. Not "recompute
 * today" — the whole point is that the historical chart must change too, and a
 * system that only refreshed current value would leave the past silently
 * disagreeing with the transactions behind it (SPEC-006 DL-006-03).
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SnapshotDependencies {
  readonly calendar: TradingCalendar;
  readonly prices: PriceHistoryPort;
  readonly contracts: FixedIncomeContractPort;
  readonly indexSeries: IndexSeriesReaderPort;
  readonly assets: AssetCatalogPort;
  readonly snapshots: SnapshotRepositoryPort;
}

/** Every asset the ledger touches, deduplicated and in a stable order. */
export function distinctAssetIds(transactions: readonly Transaction[]): readonly AssetId[] {
  const seen = new Set<AssetId>();
  for (const transaction of transactions) seen.add(transaction.assetId);
  return [...seen].sort();
}

/**
 * BR-009-18: the earliest date whose figures a rebuild must start from.
 * `null` for an empty ledger — a tenant with no transactions has no snapshots,
 * which is different from having snapshots that are all zero.
 */
export function earliestTradeDate(transactions: readonly Transaction[]): BusinessDate | null {
  let earliest: BusinessDate | null = null;
  for (const transaction of transactions) {
    if (earliest === null || BusinessDate.isBefore(transaction.tradeDate, earliest)) {
      earliest = transaction.tradeDate;
    }
  }
  return earliest;
}

/**
 * Loads the price history, contracts and index series covering `[from, to]`.
 *
 * The `getCloseOnOrBefore(asset, from)` anchor is what makes BR-009-03's
 * carry-forward work at the *start* of the range: without it, a range
 * beginning on a Monday holiday would find no close at all and fall back to
 * cost, even though last Friday's close is right there.
 */
export async function loadValuationContext(
  // Narrower than `SnapshotDependencies` on purpose: loading a context is a
  // pure read, and typing it against the write port would let a future edit
  // persist something from inside what callers treat as a query.
  deps: Omit<SnapshotDependencies, 'snapshots'>,
  transactions: readonly Transaction[],
  from: BusinessDate,
  to: BusinessDate,
): Promise<ValuationContext> {
  return loadValuationContextForAssets(deps, distinctAssetIds(transactions), from, to);
}

/**
 * The same load, keyed by asset ids rather than by a ledger.
 *
 * A report knows what is held from SPEC-007's `positions` cache and must never
 * touch `transactions` to find out (DL-011-07, TS-32). Deriving the asset list
 * from a ledger it is not allowed to read would be a contradiction, so the
 * list is the parameter.
 */
export async function loadValuationContextForAssets(
  deps: Omit<SnapshotDependencies, 'snapshots'>,
  assetIds: readonly AssetId[],
  from: BusinessDate,
  to: BusinessDate,
): Promise<ValuationContext> {
  const assets = new Map<AssetId, Asset>();
  const contracts = new Map<AssetId, FixedIncomeContract>();
  const closes = new Map<AssetId, readonly PriceQuote[]>();
  const latest = new Map<AssetId, LatestQuote>();

  for (const asset of await deps.assets.findByIds(assetIds)) {
    assets.set(asset.id, asset);
  }

  for (const assetId of assetIds) {
    const asset = assets.get(assetId);
    if (asset !== undefined && FIXED_INCOME_CLASSES.has(asset.assetClass)) {
      // BR-009-07: only bank paper has a contract. Asking the port for a
      // PETR4 contract would be a query that can only ever return null.
      const contract = await deps.contracts.findByAssetId(assetId);
      if (contract !== null) contracts.set(assetId, contract);
      continue;
    }
    const anchor = await deps.prices.getCloseOnOrBefore(assetId, from);
    const inRange = await deps.prices.listCloses(assetId, from, to);
    // The anchor is on-or-before `from`, so it either precedes every in-range
    // row or *is* the first of them; dropping the duplicate keeps the array
    // strictly ascending with no repeated date.
    const history =
      anchor === null || (inRange[0] !== undefined && inRange[0].date === anchor.date)
        ? inRange
        : [anchor, ...inRange];
    closes.set(assetId, history);
    const quote = await deps.prices.getLatestQuote(assetId);
    if (quote !== null) latest.set(assetId, quote);
  }

  /**
   * The CDI window starts at the earliest issue date across contracts, not at
   * `from`: a CDB issued in 2023 and valued in 2026 accrues over every
   * business day since issue, so a window clipped to the report range would
   * silently lose three years of compounding.
   */
  let seriesFrom = from;
  for (const contract of contracts.values()) {
    if (BusinessDate.isBefore(contract.issueDate, seriesFrom)) seriesFrom = contract.issueDate;
  }
  const [cdi, ipca] =
    contracts.size === 0
      ? [[], []]
      : await Promise.all([
          deps.indexSeries.listPoints('CDI', seriesFrom, to),
          deps.indexSeries.listPoints('IPCA', seriesFrom, to),
        ]);

  return { calendar: deps.calendar, assets, contracts, closes, latest, cdi, ipca };
}

// ---------------------------------------------------------------------------
// Valuing a portfolio on one date
// ---------------------------------------------------------------------------

/**
 * SPEC-007 BR-007-05c: the context already holds every asset of the ledger it
 * was loaded for, which is exactly what an amortization's principal depends on
 * — both for valuing a position and for the cost a transfer carries out of one.
 */
export function amortizationOf(context: ValuationContext): AmortizationTerms {
  return amortizationTermsOf(
    [...context.assets.values()].map((asset) => ({
      assetId: asset.id,
      code: asset.code,
      assetClass: asset.assetClass,
    })),
  );
}

/**
 * BR-009-16 / AC-16 — every open position on `asOf`, valued by the method its
 * asset class demands.
 *
 * Positions closed to zero are dropped rather than valued. They are worth
 * nothing by definition, they carry no price, and keeping them would put a
 * "price unavailable" flag on every asset a user has ever finished selling —
 * noise that would bury the flags that mean something (BR-009-13).
 *
 * `mode` is BR-009-02's guard rail. `historical` never reads an intraday
 * quote; `current` is only ever passed for today.
 */
export function valuePortfolioAt(
  context: ValuationContext,
  transactions: readonly Transaction[],
  asOf: BusinessDate,
  mode: ListedValuationMode,
): Result<readonly ValuedPosition[], DomainError> {
  const replayed = replayPositions(transactions, {
    asOf,
    amortization: amortizationOf(context),
  });
  if (!replayed.ok) return replayed;

  // BR-007-08: positions are held per (asset, institution); a portfolio value
  // is per asset, so they aggregate cost-weighted before anything is priced.
  // A report does the opposite and values each (asset, institution) row
  // separately, because it groups by institution — both reach the same total,
  // which is what `valueHoldingsAt` documents and TS-12 asserts.
  const holdings: Holding[] = aggregateAcrossInstitutions(replayed.value).map((position) => ({
    assetId: position.assetId,
    quantity: position.state.quantity,
    averageCost: position.state.averageCost,
  }));

  return valueHoldingsAt(context, holdings, asOf, mode);
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * The **external** flows, and only those: money the user put in or took out.
 *
 * Price change is not a flow. Earnings are not a flow — they are recognised
 * separately, at pay date, and never assumed reinvested (SPEC-014). Corporate
 * events move quantity without moving money and contribute nothing. Getting
 * this set wrong is what makes SPEC-012's TWR stop being TWR: TWR neutralises
 * exactly these and nothing else.
 *
 * **A transfer is a flow at the cost basis it carries** (SPEC-013 BR-013-08,
 * amended 2026-09-29 / DL-013-08): a `transfer_in` at the cost it opens its
 * lot with — `quantity × unitPrice + fees`, exactly what `applyAcquisition`
 * adds — and a `transfer_out` at the cost it takes away from its source,
 * which is not on the row at all. B3 exports the debit with no price
 * (SPEC-005 BR-005-20a), so reading it from `unitPrice` flowed every debit at
 * R$ 0 and counted each move between the user's own brokers as a deposit of
 * its whole cost basis (#181: R$ 193.802,75 on the owner's ledger). The debit's
 * cost is read off the source position by `costsCarriedOut` and passed in as
 * `carriedOut`; a stated price on a debit is ignored.
 *
 * Worked example (DV-17): 100 PETR4 bought at Clear for 3.215,00 move to XP.
 *
 *   buy at Clear            +100 × 32,15              = +3.215,00
 *   transfer_out at Clear   −100 × round₈(32,15)      = −3.215,00  (price-less)
 *   transfer_in at XP       +100 × 32,15 (carried)    = +3.215,00
 *   net contributions                                 =  3.215,00  — the buy
 *
 * The pair nets to exactly zero; only a one-sided transfer is money in or
 * out. A credit B3 exported *with its own price* (#145) opens its lot at that
 * price and so flows in at it, while its debit still flows out at the
 * carried cost: the pair then nets to the difference, which is real — the
 * lot's cost basis changed by that much, and net contributions track cost.
 *
 * Fees keep the sign convention of every other leg (`computeTotalValue`): a
 * fee is money the user spent, so it adds to a transfer in and offsets a
 * transfer out, as it offsets a sale's proceeds.
 *
 * `carriedOut` is required for a `transfer_out` and ignored for every other
 * type. Omitting it throws rather than returning R$ 0 — R$ 0 is the defect.
 */
export function externalFlow(transaction: Transaction, carriedOut: Money | null = null): Money {
  if (transaction.type === 'transfer_out') {
    if (carriedOut === null) {
      throw new RangeError(
        'externalFlow: a transfer_out flows at the cost it carries out (SPEC-013 BR-013-08) — pass it from costsCarriedOut',
      );
    }
    return carriedOut.minus(transaction.fees).negated();
  }
  /**
   * Recomputed from `quantity`, `unitPrice` and `fees` — **never read from
   * `transaction.totalValue`**.
   *
   * `totalValue` is a persisted derivation kept for the history list, filters
   * and CSV export (BR-006-07..10), and SPEC-006 is explicit that the position
   * engine must not read it: a stale or hand-edited denormalisation would
   * otherwise reach a *preço médio*. The identical argument applies here. Net
   * contributions feed SPEC-012's TWR, so a stale total would corrupt a
   * return figure with no visible cause — the exact failure mode this engine
   * exists to prevent, and one nothing downstream could detect.
   */
  const cashEffect = computeTotalValue(
    transaction.type,
    transaction.quantity,
    transaction.unitPrice,
    transaction.fees,
  );
  switch (transaction.type) {
    case 'buy':
    case 'subscription':
    case 'transfer_in':
      return cashEffect;
    case 'sell':
      return cashEffect.negated();
    default:
      return Money.zero();
  }
}

/** What the flow fold needs beyond the ledger itself. */
export interface FlowOptions {
  /**
   * SPEC-007 BR-007-05c: an amortization before a `transfer_out` lowers the
   * cost the debit carries away, so the fold needs the same terms as the
   * valuation (`amortizationOf`). A ledger holding an amortization the terms
   * do not cover fails rather than guessing.
   */
  readonly amortization?: AmortizationTerms | undefined;
}

interface RunningFlows {
  readonly netContributions: Money;
  readonly earningsToDate: Money;
}

const NO_FLOWS: RunningFlows = {
  netContributions: Money.zero(),
  earningsToDate: Money.zero(),
};

function applyFlow(
  running: RunningFlows,
  transaction: Transaction,
  carriedOut: ReadonlyMap<TransactionId, Money>,
): RunningFlows {
  // BR-006-03: only active rows are calculated on. `unclassified` rows stay
  // visible in the ledger and out of the arithmetic.
  if (transaction.status !== 'active') return running;
  if (isEarnings(transaction.type)) {
    return {
      netContributions: running.netContributions,
      // Recognised at pay date (`tradeDate` for a provento) — never accrued
      // forward from an ex-date, never assumed reinvested.
      earningsToDate: running.earningsToDate.plus(transaction.totalValue),
    };
  }
  return {
    netContributions: running.netContributions.plus(
      // `costsCarriedOut` values every active debit it was given or fails, so
      // a debit here always finds its cost; every other type has none.
      externalFlow(transaction, carriedOut.get(transaction.id) ?? null),
    ),
    earningsToDate: running.earningsToDate,
  };
}

/**
 * Every active flow with `tradeDate <= date`, summed from scratch — including
 * the debits' carried costs, re-derived from the ledger cut at `date`.
 */
function flowsThrough(
  transactions: readonly Transaction[],
  date: BusinessDate,
  options: FlowOptions,
): Result<RunningFlows, DomainError> {
  const carriedOut = costsCarriedOut(transactions, {
    asOf: date,
    amortization: options.amortization,
  });
  if (!carriedOut.ok) return carriedOut;
  let running = NO_FLOWS;
  for (const transaction of transactions) {
    if (BusinessDate.isAfter(transaction.tradeDate, date)) continue;
    running = applyFlow(running, transaction, carriedOut.value);
  }
  return ok(running);
}

// ---------------------------------------------------------------------------
// Building snapshots
// ---------------------------------------------------------------------------

function totalsOf(valued: readonly ValuedPosition[]): {
  total: Money;
  byAssetClass: ReadonlyMap<AssetClass, Money>;
  hasEstimates: boolean;
} {
  const byAssetClass = new Map<AssetClass, Money>();
  let total = Money.zero();
  let hasEstimates = false;
  for (const position of valued) {
    total = total.plus(position.value);
    byAssetClass.set(
      position.assetClass,
      (byAssetClass.get(position.assetClass) ?? Money.zero()).plus(position.value),
    );
    // BR-009-11: one accrued component is enough to mark the day's figure.
    if (position.estimated) hasEstimates = true;
  }
  // Sorted so two runs serialise byte-identically — DM-4's comparison is only
  // meaningful if the representation is deterministic.
  const sorted = new Map<AssetClass, Money>(
    [...byAssetClass.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
  return { total, byAssetClass: sorted, hasEstimates };
}

/**
 * BR-009-16 — one snapshot, computed independently of every other date.
 *
 * This is the *authoritative* definition: the figures for a date are a
 * function of the whole ledger up to that date and nothing else. The
 * carried-forward variant below must agree with it exactly (DM-4 / TS-08).
 *
 * A `Result` because a transfer out's flow is read off its source position
 * (SPEC-013 BR-013-08), and a position that cannot be replayed has no cost to
 * carry — that is reported, never flowed as zero.
 */
export function buildSnapshot(
  date: BusinessDate,
  valued: readonly ValuedPosition[],
  transactions: readonly Transaction[],
  options: FlowOptions = {},
): Result<DailyValuationSnapshot, DomainError> {
  const flows = flowsThrough(transactions, date, options);
  if (!flows.ok) return flows;
  const { total, byAssetClass, hasEstimates } = totalsOf(valued);
  return ok({
    date,
    totalValue: total,
    netContributions: flows.value.netContributions,
    // #183: calc-engine replaces this with market-valued flows
    marketFlows: flows.value.netContributions,
    earningsToDate: flows.value.earningsToDate,
    byAssetClass,
    hasEstimates,
  });
}

/**
 * DM-4 / TS-08 — the same series, built the way a daily job actually builds
 * it: the running flow totals are carried forward from the previous date and
 * only that day's transactions are added.
 *
 * Keeping both implementations is the point. `buildSnapshot` re-derives from
 * the whole ledger, this one accumulates; asserting that they agree over a
 * generated history is what catches the accumulation and ordering bugs that
 * every other test walks past.
 *
 * The debits' carried costs are folded **once**, over the ledger up to the
 * last date, where `buildSnapshot` re-folds them per date from a ledger cut
 * there. The two agree because a debit's cost depends only on rows that sort
 * before it (`compareForReplay` orders by date first), so no later row can
 * change it — which is exactly the claim the DM-4 property test puts to them.
 */
export function buildSnapshotSeries(
  dates: readonly BusinessDate[],
  valuedByDate: ReadonlyMap<BusinessDate, readonly ValuedPosition[]>,
  transactions: readonly Transaction[],
  options: FlowOptions = {},
): Result<readonly DailyValuationSnapshot[], DomainError> {
  const last = dates.at(-1);
  if (last === undefined) return ok([]);
  const carriedOut = costsCarriedOut(transactions, {
    asOf: last,
    amortization: options.amortization,
  });
  if (!carriedOut.ok) return carriedOut;

  // Ascending by trade date, so the walk below can consume the ledger once.
  const ordered = [...transactions].sort((a, b) => BusinessDate.compare(a.tradeDate, b.tradeDate));

  const snapshots: DailyValuationSnapshot[] = [];
  let cursor = 0;
  let running = NO_FLOWS;
  for (const date of dates) {
    while (cursor < ordered.length) {
      const next = ordered[cursor];
      if (next === undefined || BusinessDate.isAfter(next.tradeDate, date)) break;
      running = applyFlow(running, next, carriedOut.value);
      cursor += 1;
    }
    const { total, byAssetClass, hasEstimates } = totalsOf(valuedByDate.get(date) ?? []);
    snapshots.push({
      date,
      totalValue: total,
      netContributions: running.netContributions,
      // #183: calc-engine replaces this with market-valued flows
      marketFlows: running.netContributions,
      earningsToDate: running.earningsToDate,
      byAssetClass,
      hasEstimates,
    });
  }
  return ok(snapshots);
}

/** Exact structural equality — the DM-4 gate compares values, not identity. */
export function snapshotsEqual(a: DailyValuationSnapshot, b: DailyValuationSnapshot): boolean {
  if (
    a.date !== b.date ||
    !a.totalValue.equals(b.totalValue) ||
    !a.netContributions.equals(b.netContributions) ||
    !a.marketFlows.equals(b.marketFlows) ||
    !a.earningsToDate.equals(b.earningsToDate) ||
    a.hasEstimates !== b.hasEstimates ||
    a.byAssetClass.size !== b.byAssetClass.size
  ) {
    return false;
  }
  for (const [assetClass, value] of a.byAssetClass) {
    const other = b.byAssetClass.get(assetClass);
    if (other === undefined || !value.equals(other)) return false;
  }
  return true;
}

/**
 * AR-10 — the JSON boundary. `by_asset_class` is `jsonb`, and a `Decimal` that
 * reaches `JSON.stringify` comes back a float, so every figure crosses as the
 * plain decimal string `Money.toString()` produces.
 */
export function serializeSnapshot(snapshot: DailyValuationSnapshot): SerializedSnapshot {
  const byAssetClass: Record<string, string> = {};
  for (const [assetClass, value] of snapshot.byAssetClass) {
    byAssetClass[assetClass] = value.toString();
  }
  return {
    date: snapshot.date,
    totalValue: snapshot.totalValue.toString(),
    netContributions: snapshot.netContributions.toString(),
    marketFlows: snapshot.marketFlows.toString(),
    earningsToDate: snapshot.earningsToDate.toString(),
    byAssetClass,
    hasEstimates: snapshot.hasEstimates,
  };
}

export function deserializeAssetClassBreakdown(
  raw: Readonly<Record<string, string>>,
): ReadonlyMap<AssetClass, Money> {
  const breakdown = new Map<AssetClass, Money>();
  for (const [assetClass, value] of Object.entries(raw).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    breakdown.set(assetClass as AssetClass, Money.fromString(value));
  }
  return breakdown;
}

// ---------------------------------------------------------------------------
// The two use cases
// ---------------------------------------------------------------------------

export interface RebuildRange {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
  /**
   * BR-009-02 / AC-2: the only date that may consult an intraday quote. Any
   * other date in the range is history and reads closes only. Omitted means
   * every date is historical — which is what a backfill wants.
   */
  readonly currentDate?: BusinessDate | undefined;
}

/**
 * BR-009-16/17 — build (or rebuild) every snapshot in a date range from the
 * ledger, the price history and the index series, and persist them.
 *
 * BR-009-18: the caller supplies `from`. For a backdated edit that is the
 * edited transaction's trade date — the date *before* any clamp to
 * `earliestTradeDate`. Snapshots at or after `from` are deleted before the new
 * ones are written, so a range that has shrunk (every transaction in a period
 * deleted) does not leave orphaned rows behind claiming a value that no longer
 * has a ledger under it. **Not for a full rebuild**: passing
 * `earliestTradeDate` here would keep every snapshot dated before the ledger's
 * current first trade (#182). The worker's `rebuildTenant` invalidates with
 * `persistSnapshots(…, null)` for that case.
 */
export async function rebuildSnapshots(
  deps: SnapshotDependencies,
  transactions: readonly Transaction[],
  range: RebuildRange,
): Promise<Result<readonly DailyValuationSnapshot[], DomainError>> {
  const computed = await computeSnapshots(deps, transactions, range);
  if (!computed.ok) return computed;
  await persistSnapshots(deps.snapshots, computed.value, range.from);
  return computed;
}

/**
 * The **read half** of a rebuild: everything from `loadValuationContext` to a
 * finished series of snapshots, touching no tenant-scoped table.
 *
 * Split out from the write half for a reason that is not stylistic. Every
 * table read here — `assets`, `price_quotes`, `index_series` — is shared
 * reference data (AR-15), so none of it needs tenant context; but running it
 * *inside* the caller's `withTenant` transaction means the tenant connection
 * is held while unrelated queries ask the pool for another one. On a pool
 * sized at one that deadlocks outright, and on any pool it holds a
 * transaction open across work that never needed it.
 *
 * So the composition is: read the ledger in a tenant transaction, compute
 * here with no transaction at all, then write in a second tenant transaction.
 * The write stays atomic, which is the only part that has to be.
 */
export async function computeSnapshots(
  deps: Omit<SnapshotDependencies, 'snapshots'>,
  transactions: readonly Transaction[],
  range: RebuildRange,
): Promise<Result<readonly DailyValuationSnapshot[], DomainError>> {
  const context = await loadValuationContext(deps, transactions, range.from, range.to);
  const dates = listCalendarDays(range.from, range.to);

  const valuedByDate = new Map<BusinessDate, readonly ValuedPosition[]>();
  for (const date of dates) {
    const valued = valuePortfolioAt(
      context,
      transactions,
      date,
      date === range.currentDate ? 'current' : 'historical',
    );
    if (!valued.ok) return valued;
    valuedByDate.set(date, valued.value);
  }

  return buildSnapshotSeries(dates, valuedByDate, transactions, {
    amortization: amortizationOf(context),
  });
}

/**
 * AR-06/AR-28: `NUMERIC(20,8)` is the persisted precision. Eight decimal
 * places, and no column in this schema can hold a ninth.
 */
export const STORED_SCALE = 8;

/**
 * Quantises a snapshot to the precision the database can actually hold —
 * **the one rounding step in this module, done explicitly and named.**
 *
 * Why it has to exist, rather than letting the column do it. A snapshot's
 * figures land in two different storage types: `total_value` is
 * `NUMERIC(20,8)`, which Postgres silently rounds to scale on write, while
 * `by_asset_class` is `jsonb`, which stores whatever string it is given —
 * all forty significant digits of it. Left implicit, the same snapshot is
 * therefore persisted at *two different precisions*, and the parts stop
 * adding up to the total: the Composition report (reading the breakdown) and
 * the Portfolio Value endpoint (reading the total) disagree by up to 1e-8 per
 * asset class. That is AC-16 and TS-12's cross-report invariant, broken by a
 * storage detail nobody would look for.
 *
 * Two decisions, both deliberate:
 *
 *  1. **`ROUND_HALF_UP`**, because that is what Postgres does when it reduces
 *     a NUMERIC to scale. Choosing anything else would mean the explicit
 *     quantisation and the column fought each other, reintroducing the
 *     discrepancy this function exists to remove.
 *  2. **The total is the sum of the quantised parts**, not the quantised sum.
 *     Those differ by up to half an ulp per class, and only the first makes
 *     "the total equals the sum of its parts" exactly true on the stored rows
 *     — which is the invariant a user can actually see.
 *
 * This does not contradict AR-09's "rounding only at display". AR-09 forbids
 * rounding *intermediates in the domain*; the figures here are finished, and
 * this is the storage boundary, where the declared column precision applies.
 * The domain above this line stays exact.
 */
export function quantizeSnapshot(snapshot: DailyValuationSnapshot): DailyValuationSnapshot {
  const byAssetClass = new Map<AssetClass, Money>();
  let total = Money.zero();
  for (const [assetClass, value] of snapshot.byAssetClass) {
    const quantized = quantizeMoney(value);
    byAssetClass.set(assetClass, quantized);
    total = total.plus(quantized);
  }
  return {
    date: snapshot.date,
    totalValue: total,
    netContributions: quantizeMoney(snapshot.netContributions),
    marketFlows: quantizeMoney(snapshot.marketFlows),
    earningsToDate: quantizeMoney(snapshot.earningsToDate),
    byAssetClass,
    hasEstimates: snapshot.hasEstimates,
  };
}

function quantizeMoney(value: Money): Money {
  return Money.fromString(value.toDecimal().toFixed(STORED_SCALE, Decimal.ROUND_HALF_UP));
}

/**
 * The **write half**, and the only part that must be atomic: the delete and
 * the upsert run together so a crash between them cannot leave a tenant with a
 * hole where their history was.
 *
 * `invalidateFrom` is where **deletion** starts, and it is deliberately not
 * where the first written snapshot is: a write that moves the earliest trade
 * later, or removes the ledger's earliest (or only) rows, leaves snapshots
 * *before* the new earliest date that no ledger backs any more
 * (BR-009-17: the ledger wins). Those are deleted, and none is rewritten.
 * `null` means the tenant's whole history (a full rebuild) — every snapshot
 * goes, then the new series is written.
 *
 * Quantises on the way in, so what is read back is bit-for-bit what was
 * written and two rebuilds of the same range are byte-identical (DM-4).
 */
export async function persistSnapshots(
  repository: SnapshotRepositoryPort,
  snapshots: readonly DailyValuationSnapshot[],
  invalidateFrom: BusinessDate | null,
): Promise<void> {
  if (invalidateFrom === null) await repository.deleteAll();
  else await repository.deleteFrom(invalidateFrom);
  await repository.upsertMany(snapshots.map(quantizeSnapshot));
}

/**
 * BR-009-18 / AC-15 — invalidation on its own, for the write path.
 *
 * Separate from the rebuild because they happen at different times: a
 * transaction write invalidates synchronously (so nothing can read a snapshot
 * it has just falsified) and the rebuild runs as a job. Returns how many rows
 * were dropped, so a caller can tell "nothing to invalidate" from "invalidated
 * two years of history" — the second is worth logging.
 */
export async function invalidateSnapshotsFrom(
  deps: Pick<SnapshotDependencies, 'snapshots'>,
  from: BusinessDate,
): Promise<number> {
  return deps.snapshots.deleteFrom(from);
}

/**
 * AC-16 — the invariant every report depends on: the total is the sum of its
 * parts, across all three valuation methods. Exported so the property can be
 * asserted from tests *and* re-checked cheaply in a handler.
 */
export function breakdownTotal(snapshot: DailyValuationSnapshot): Money {
  let total = Money.zero();
  for (const value of snapshot.byAssetClass.values()) total = total.plus(value);
  return total;
}
