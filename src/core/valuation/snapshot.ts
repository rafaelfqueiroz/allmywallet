import { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { AssetId, TransactionId } from '@/core/shared/ids';
import { Money, sumMoney } from '@/core/shared/money';
import { ok, type Result } from '@/core/shared/result';
import Decimal from 'decimal.js';
import { computeTotalValue, isEarnings, type Transaction } from '@/core/ledger/transaction';
import { aggregateAcrossInstitutions } from '@/core/positions/aggregate';
import { type AmortizationTerms, amortizationTermsOf } from '@/core/positions/amortization';
import { averagesCarriedOut } from '@/core/positions/carried-out';
import { pairLedgerTransfers } from '@/core/ledger/transfer-pairs';
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
 * This is one row's contribution to **`netContributions`** — the figure
 * *Total investido* and *Ganho* read, where a transfer counts at the cost
 * basis it carries. Whether a transfer counts *at all* is the fold's decision
 * (`flowOf` below: a paired transfer counts nowhere, SPEC-013 BR-013-08 as
 * amended by #183), and so is its market-valued twin, `marketFlows`.
 *
 * **A transfer is a flow at the cost basis it carries** (SPEC-013 BR-013-08 /
 * DL-013-08): a `transfer_in` at the cost it opens its lot with —
 * `quantity × unitPrice + fees`, exactly what `applyAcquisition` adds — and a
 * `transfer_out` at the cost it takes away from its source, which is not on
 * the row at all. B3 exports the debit with no price (SPEC-005 BR-005-20a), so
 * reading it from `unitPrice` flowed every debit at R$ 0 (#181: R$ 193.802,75
 * of phantom deposits on the owner's ledger). The debit's cost is read off
 * the source position (`averagesCarriedOut` × quantity) and passed in as
 * `carriedOut`; a stated price on a debit is ignored.
 *
 * Worked example (DV-17): 40 shares leave for someone else's custody from a
 * lot bought as 100 @ 10,00 + 5,00 of fees (average 10,05).
 *
 *   buy                     +100 × 10,00 + 5,00          = +1.005,00
 *   transfer_out (unpaired) −40 × round₈(10,05)          =   −402,00
 *   net contributions                                    =    603,00
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
  /**
   * SPEC-013 BR-013-08 / SPEC-012 BR-012-01 (#183): an **unpaired** transfer
   * enters `marketFlows` at the market value of the shares that moved, on the
   * transfer date, valued by this context exactly as a snapshot values a
   * holding (`valueHoldingsAt`, `historical` mode). It must hold a close on
   * or before every such transfer's date — `computeSnapshots` makes sure of
   * that (`withTransferCloses`) even for transfers before the range.
   *
   * Required only when the ledger holds an unpaired transfer on or before the
   * date being built; omitting it then throws rather than valuing the move at
   * zero, because zero is the one answer that is certainly wrong.
   */
  readonly context?: ValuationContext | undefined;
}

interface RunningFlows {
  readonly netContributions: Money;
  readonly marketFlows: Money;
  readonly earningsToDate: Money;
  /**
   * The trade date of the latest flow folded so far whose market value was an
   * estimate (SPEC-009 BR-009-11: accrued, or valued at cost for want of any
   * price). The snapshot dated that day is marked, because its `marketFlows`
   * step — the day's flow TWR neutralises — rests on that estimate.
   */
  readonly latestEstimate: BusinessDate | null;
}

const NO_FLOWS: RunningFlows = {
  netContributions: Money.zero(),
  marketFlows: Money.zero(),
  earningsToDate: Money.zero(),
  latestEstimate: null,
};

/** What the fold reads besides the row itself, derived once per ledger. */
interface FlowFacts {
  /** `averagesCarriedOut`: round₈ of each debit's source *preço médio*. */
  readonly averages: ReadonlyMap<TransactionId, Money>;
  /** Both legs of every BR-005-20a pair (`pairedTransferIds`). */
  readonly paired: ReadonlySet<TransactionId>;
  readonly context: ValuationContext | undefined;
}

/** One row's share of each running figure. */
interface RowFlow {
  readonly contribution: Money;
  readonly market: Money;
  readonly estimated: boolean;
}

/** A move between the user's own custodians: no money in or out, on either figure. */
const INTERNAL: RowFlow = { contribution: Money.zero(), market: Money.zero(), estimated: false };

/**
 * SPEC-005 BR-005-20a over the ledger — both legs of every one-to-one pair,
 * as one set. The pairing is `pairLedgerTransfers`, the very relation import
 * carries a credit's cost by, so what the snapshot calls internal is exactly
 * what the ledger paired.
 */
export function pairedTransferIds(transactions: readonly Transaction[]): ReadonlySet<TransactionId> {
  const paired = new Set<TransactionId>();
  for (const [credit, debit] of pairLedgerTransfers(transactions)) {
    paired.add(credit);
    paired.add(debit);
  }
  return paired;
}

function flowFactsOf(
  transactions: readonly Transaction[],
  asOf: BusinessDate,
  options: FlowOptions,
): Result<FlowFacts, DomainError> {
  const averages = averagesCarriedOut(transactions, {
    asOf,
    amortization: options.amortization,
  });
  if (!averages.ok) return averages;
  return ok({
    averages: averages.value,
    paired: pairedTransferIds(transactions),
    context: options.context,
  });
}

/**
 * **One row's flow, on both figures** — SPEC-013 BR-013-08 as amended by #183
 * (DL-013-09, DL-013-10), SPEC-012 BR-012-01 (DL-012-08).
 *
 * - **Every type but a transfer**: `marketFlows` takes exactly what
 *   `netContributions` takes. A buy, a sale or a subscription is cash at the
 *   transaction's own price, which *is* its market value on that date.
 * - **A paired transfer** — debit and credit that BR-005-20a matches
 *   one-to-one — is a move between the user's own custodians and contributes
 *   **zero to both**, whatever price either leg carries. Pairing, not price,
 *   is what makes a move internal.
 * - **An unpaired transfer** is money in or out. `netContributions` takes it
 *   at the cost it carries (`externalFlow`, DL-013-08); `marketFlows` at the
 *   **market value of the shares that moved on the transfer date** (GIPS: an
 *   in-kind flow is valued at market), signed like the cost.
 *
 * Worked examples (DV-17), each the #183 shape it fixes:
 *
 *   #145, a priced credit paired with its debit — 100 carried at 10,00 at
 *   Clear, credited at XP at B3's 12,50, close 11,00:
 *     before  net +1.250,00 − 1.000,00 = +250,00, a deposit that never happened
 *     now     net 0, market 0
 *
 *   #112, a credit on a stored fallback cost — the source holds 10 free
 *   bonificação shares (cost 0) and the credit was carried at 5,00:
 *     before  net +50,00 − 0,00 = +50,00
 *     now     net 0, market 0
 *
 *   One-sided out — 100 shares, cost 10,00, close 40,00 on the date:
 *     net     −100 × 10,00 = −1.000,00  (Total investido falls by the cost)
 *     market  −100 × 40,00 = −4.000,00  (the value that left; TWR reads 0 %,
 *                                         not (0 − 4.000 + 1.000) ÷ 4.000 = −75 %)
 *
 *   One-sided in — 100 carried at 8,00, close 11,00 on the date:
 *     net     +100 × 8,00  =   +800,00
 *     market  +100 × 11,00 = +1.100,00  (the 300,00 of appreciation before
 *                                         the user tracked the shares is not
 *                                         this portfolio's price change)
 *
 * **The market value is SPEC-009's**, never a price read by hand: the moved
 * quantity is valued as a holding by `valueHoldingsAt` in `historical` mode
 * (BR-009-02 — never an intraday quote, even when the transfer is dated
 * today, so the figure does not move with the time of day and DM-4 holds).
 * That settles every edge the same way the snapshot's own total settles it:
 *
 * - **No close on the transfer date**: the last close on or before it
 *   (BR-009-03 carry-forward) — a weekend or holiday transfer takes Friday's.
 * - **No close on or before it at all**: valued at cost and marked an
 *   estimate (`COST_FALLBACK`), exactly as the engine values such a position;
 *   never zero. The snapshot of the transfer date is then marked
 *   `hasEstimates`, because its flow step rests on that estimate.
 * - **Tesouro Direto**: its published sell price, same fallback.
 * - **Bank paper (CDB/LCI/LCA)**: accrued from the contract to the transfer
 *   date on the leg's own cost basis — an estimate by nature (BR-009-11), so
 *   the date is marked.
 *
 * The cost a fallback or an accrual starts from is the leg's own per-share
 * figure: the credit's `unitPrice`, or the debit's round₈ source average — the
 * same figure `netContributions` takes it at.
 *
 * **Fees are not part of the market flow.** GIPS values an in-kind flow at
 * the market value of the securities that moved; a transfer fee is paid
 * around the move, not moved with it, and a listed holding's value
 * (quantity × close) never includes it — so a fee in the flow would read as a
 * return the holdings never made. `netContributions` keeps the fee
 * (DL-013-08's convention), because *Total investido* counts what the user
 * spent.
 *
 * **Rounding**: none. `quantity × close` is exact in `decimal.js` (at most 16
 * places from two 8-place factors), just as the snapshot's own `totalValue`
 * is; the only rounding step is `quantizeSnapshot`'s at the storage boundary.
 * An accrued value carries the accrual chain's 40 significant digits, again
 * exactly as the position it came from.
 */
function flowOf(transaction: Transaction, facts: FlowFacts): Result<RowFlow, DomainError> {
  if (transaction.type !== 'transfer_in' && transaction.type !== 'transfer_out') {
    const cash = externalFlow(transaction);
    return ok({ contribution: cash, market: cash, estimated: false });
  }
  // SPEC-013 BR-013-08 (DL-013-09): internal, whatever either leg's price says.
  if (facts.paired.has(transaction.id)) return ok(INTERNAL);

  const inbound = transaction.type === 'transfer_in';
  // `averagesCarriedOut` values every active debit on or before its cut, or
  // fails — and the fold only reaches rows on or before it — so a debit here
  // always finds its figure.
  const average = inbound ? transaction.unitPrice : (facts.averages.get(transaction.id) as Money);
  const contribution = externalFlow(
    transaction,
    inbound ? null : average.times(transaction.quantity),
  );
  const market = marketValueMoved(facts.context, transaction, average);
  if (!market.ok) return market;
  return ok({
    contribution,
    market: inbound ? market.value.value : market.value.value.negated(),
    estimated: market.value.estimated,
  });
}

/**
 * SPEC-009 BR-009-16 applied to the shares a transfer moved, on its own date:
 * the quantity valued as one holding at the leg's per-share cost. Summed over
 * whatever `valueHoldingsAt` returns — one position, or none for a
 * zero-quantity row — so there is no path on which a figure is invented.
 */
function marketValueMoved(
  context: ValuationContext | undefined,
  transaction: Transaction,
  averageCost: Money,
): Result<{ readonly value: Money; readonly estimated: boolean }, DomainError> {
  if (context === undefined) {
    throw new RangeError(
      'buildSnapshot: an unpaired transfer flows at the market value it moved (SPEC-013 BR-013-08) — pass the valuation context',
    );
  }
  const valued = valueHoldingsAt(
    context,
    [{ assetId: transaction.assetId, quantity: transaction.quantity, averageCost }],
    transaction.tradeDate,
    'historical',
  );
  if (!valued.ok) return valued;
  return ok({
    value: sumMoney(valued.value.map((position) => position.value)),
    estimated: valued.value.some((position) => position.estimated),
  });
}

function applyFlow(
  running: RunningFlows,
  transaction: Transaction,
  facts: FlowFacts,
): Result<RunningFlows, DomainError> {
  // BR-006-03: only active rows are calculated on. `unclassified` rows stay
  // visible in the ledger and out of the arithmetic.
  if (transaction.status !== 'active') return ok(running);
  if (isEarnings(transaction.type)) {
    return ok({
      ...running,
      // Recognised at pay date (`tradeDate` for a provento) — never accrued
      // forward from an ex-date, never assumed reinvested.
      earningsToDate: running.earningsToDate.plus(transaction.totalValue),
    });
  }
  const flow = flowOf(transaction, facts);
  if (!flow.ok) return flow;
  return ok({
    netContributions: running.netContributions.plus(flow.value.contribution),
    marketFlows: running.marketFlows.plus(flow.value.market),
    earningsToDate: running.earningsToDate,
    // Both folds walk the ledger in trade-date order (`byTradeDate`), so the
    // latest estimated row is simply the last one seen.
    latestEstimate: flow.value.estimated ? transaction.tradeDate : running.latestEstimate,
  });
}

/**
 * The one order both folds sum in: ascending trade date, ties in the order
 * the ledger was given (a stable sort). Sums of exact figures do not care,
 * but an accrued market value carries 40 significant digits, and two folds
 * adding the same figures in two orders could disagree in the last of them —
 * which DM-4's exact comparison would, rightly, report.
 */
function byTradeDate(transactions: readonly Transaction[]): readonly Transaction[] {
  return [...transactions].sort((a, b) => BusinessDate.compare(a.tradeDate, b.tradeDate));
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
  const facts = flowFactsOf(transactions, date, options);
  if (!facts.ok) return facts;
  let running = NO_FLOWS;
  for (const transaction of byTradeDate(transactions)) {
    if (BusinessDate.isAfter(transaction.tradeDate, date)) continue;
    const next = applyFlow(running, transaction, facts.value);
    if (!next.ok) return next;
    running = next.value;
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
    marketFlows: flows.value.marketFlows,
    earningsToDate: flows.value.earningsToDate,
    byAssetClass,
    // BR-009-11, and #183: a flow valued by estimate marks its own date.
    hasEstimates: hasEstimates || flows.value.latestEstimate === date,
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
  const facts = flowFactsOf(transactions, last, options);
  if (!facts.ok) return facts;

  // Ascending by trade date, so the walk below can consume the ledger once.
  const ordered = byTradeDate(transactions);

  const snapshots: DailyValuationSnapshot[] = [];
  let cursor = 0;
  let running = NO_FLOWS;
  for (const date of dates) {
    while (cursor < ordered.length) {
      const next = ordered[cursor];
      if (next === undefined || BusinessDate.isAfter(next.tradeDate, date)) break;
      const applied = applyFlow(running, next, facts.value);
      if (!applied.ok) return applied;
      running = applied.value;
      cursor += 1;
    }
    const { total, byAssetClass, hasEstimates } = totalsOf(valuedByDate.get(date) ?? []);
    snapshots.push({
      date,
      totalValue: total,
      netContributions: running.netContributions,
      marketFlows: running.marketFlows,
      earningsToDate: running.earningsToDate,
      byAssetClass,
      // BR-009-11, and #183: a flow valued by estimate marks its own date.
      hasEstimates: hasEstimates || running.latestEstimate === date,
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
    // SPEC-013 BR-013-08 (#183): the flows are cumulative from the ledger's
    // first row, not from `range.from`, so an unpaired transfer dated before
    // the range is still valued — at its own date's close, which the range's
    // context does not hold.
    context: await withTransferCloses(deps.prices, context, transactions, range.from),
  });
}

/**
 * SPEC-013 BR-013-08 (#183) — the closes an **unpaired transfer dated before
 * `from`** is valued at, added to a context loaded for `[from, to]`.
 *
 * A rebuild of a short range — the daily job builds today alone — still sums
 * every flow since the ledger began, and an unpaired transfer's market flow is
 * the close on or before *its own* date. The range's context holds closes from
 * the anchor on or before `from` onwards only, so without this a 2024
 * transfer rebuilt in 2026 would find no close, fall back to cost, and put a
 * different `market_flows` on today's row than the full rebuild put there —
 * DM-4 broken by the choice of range.
 *
 * One `getCloseOnOrBefore` per such transfer, not a history load: the owner's
 * ledger has none today, and a transfer needs exactly one close. Inserted in
 * date order and never duplicating a date, so `closeOnOrBefore` answers every
 * other date exactly as before: each added close is the latest one on or
 * before its transfer, and precedes the range's anchor.
 *
 * Paired transfers need no price (they flow zero); bank paper has no closes
 * (it accrues from its contract and index series, loaded from issue date);
 * a transfer on or after `from` is already covered by the range's own closes.
 */
export async function withTransferCloses(
  prices: Pick<PriceHistoryPort, 'getCloseOnOrBefore'>,
  context: ValuationContext,
  transactions: readonly Transaction[],
  from: BusinessDate,
): Promise<ValuationContext> {
  const paired = pairedTransferIds(transactions);
  const closes = new Map(context.closes);
  for (const transaction of transactions) {
    if (
      transaction.status !== 'active' ||
      (transaction.type !== 'transfer_in' && transaction.type !== 'transfer_out') ||
      !BusinessDate.isBefore(transaction.tradeDate, from) ||
      paired.has(transaction.id)
    ) {
      continue;
    }
    const history = closes.get(transaction.assetId);
    // No entry at all: bank paper, valued by accrual rather than by a close.
    if (history === undefined) continue;
    const quote = await prices.getCloseOnOrBefore(transaction.assetId, transaction.tradeDate);
    if (quote === null || history.some((known) => known.date === quote.date)) continue;
    closes.set(
      transaction.assetId,
      [...history, quote].sort((a, b) => BusinessDate.compare(a.date, b.date)),
    );
  }
  return { ...context, closes };
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
