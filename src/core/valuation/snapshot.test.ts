import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import {
  aTransaction,
  assetIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { FakeAssetCatalog } from '@/core/quotes/test-support';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import {
  breakdownTotal,
  buildSnapshot,
  buildSnapshotSeries,
  deserializeAssetClassBreakdown,
  distinctAssetIds,
  earliestTradeDate,
  externalFlow,
  invalidateSnapshotsFrom,
  quantizeSnapshot,
  loadValuationContext,
  rebuildSnapshots,
  serializeSnapshot,
  snapshotsEqual,
  valuePortfolioAt,
  type SnapshotDependencies,
  type ValuationContext,
} from './snapshot';
import {
  NeedsAttentionReason,
  ValuationErrorCode,
  type AssetClass,
  type DailyValuationSnapshot,
} from './ports';
import {
  FakeFixedIncomeContracts,
  FakeIndexSeriesReader,
  FakePriceHistory,
  FakeSnapshotRepository,
  aContract,
  indexPoint,
} from './test-support';

/**
 * SPEC-009 BR-009-16..19 — the daily snapshot, the three valuation methods
 * meeting in one total, and DM-4's rebuild-equals-incremental property.
 */

const calendar = new B3TradingCalendar();
const d = (value: string): BusinessDate => BusinessDate.of(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

const PETR4 = assetIdFor('PETR4');
const TESOURO = assetIdFor('Tesouro IPCA+ 2035');
const CDB = assetIdFor('CDB BANCO X 2028');

/** CDI at 13,65 % a.a. then 13,15 % — the same fixture accrual.test.ts derives. */
const CDI = [
  indexPoint('2026-03-16', '0.05078803'),
  indexPoint('2026-03-17', '0.05078803'),
  indexPoint('2026-03-18', '0.04903749'),
  indexPoint('2026-03-19', '0.04903749'),
  indexPoint('2026-03-20', '0.04903749'),
];

function catalog(): FakeAssetCatalog {
  const assets = new FakeAssetCatalog();
  assets.add({ id: PETR4, code: 'PETR4', name: 'Petrobras PN', assetClass: 'stock' });
  assets.add({
    id: TESOURO,
    code: 'Tesouro IPCA+ 2035',
    name: 'Tesouro IPCA+ 2035',
    assetClass: 'tesouro_direto',
  });
  assets.add({ id: CDB, code: 'CDB BANCO X 2028', name: 'CDB Banco X', assetClass: 'cdb' });
  return assets;
}

interface Harness {
  readonly deps: SnapshotDependencies;
  readonly prices: FakePriceHistory;
  readonly contracts: FakeFixedIncomeContracts;
  readonly series: FakeIndexSeriesReader;
  readonly snapshots: FakeSnapshotRepository;
}

function harness(): Harness {
  const prices = new FakePriceHistory();
  const contracts = new FakeFixedIncomeContracts();
  const series = new FakeIndexSeriesReader().set('CDI', CDI).set('IPCA', []);
  const snapshots = new FakeSnapshotRepository();
  return {
    prices,
    contracts,
    series,
    snapshots,
    deps: { calendar, prices, contracts, indexSeries: series, assets: catalog(), snapshots },
  };
}

beforeEach(() => {
  // Ids and createdAt follow build order; two histories compared against each
  // other must start from the same point or the comparison becomes about
  // build order rather than arithmetic.
  resetTransactionSequence();
});

// ---------------------------------------------------------------------------

describe('distinctAssetIds / earliestTradeDate', () => {
  it('deduplicates and orders the asset set', () => {
    const ledger = [
      aTransaction().buy().of('PETR4').on('2026-03-16').build(),
      aTransaction().buy().of('PETR4').on('2026-03-17').build(),
      aTransaction().buy().of('CDB BANCO X 2028').on('2026-03-16').build(),
    ];
    expect(distinctAssetIds(ledger)).toHaveLength(2);
  });

  it('an empty ledger has no earliest date — which is not the same as a zero snapshot', () => {
    expect(earliestTradeDate([])).toBeNull();
  });

  it('finds the earliest trade date regardless of arrival order', () => {
    const ledger = [
      aTransaction().buy().on('2026-03-20').build(),
      aTransaction().buy().on('2026-01-05').build(),
      aTransaction().buy().on('2026-03-16').build(),
    ];
    expect(earliestTradeDate(ledger)).toBe('2026-01-05');
  });
});

// ---------------------------------------------------------------------------

describe('externalFlow — what TWR will have to neutralise, and nothing else', () => {
  it('buys, subscriptions and transfers in are positive contributions', () => {
    // 100 × 32,15 + 4,90 of fees = 3.219,90 — a buy costs the fees too.
    const buy = aTransaction().buy().quantity('100').price('32.15').fees('4.90').build();
    expect(to8(externalFlow(buy))).toBe('3219.90000000');
    expect(externalFlow(aTransaction().subscription().build()).isPositive()).toBe(true);
    expect(externalFlow(aTransaction().transferIn().build()).isPositive()).toBe(true);
  });

  it('sells and transfers out are negative, net of the fees they cost', () => {
    // 100 × 38,42 − 4,90 = 3.837,10 leaving the portfolio.
    const sell = aTransaction().sell().quantity('100').price('38.42').fees('4.90').build();
    expect(to8(externalFlow(sell))).toBe('-3837.10000000');
    expect(externalFlow(aTransaction().transferOut().build()).isNegative()).toBe(true);
  });

  it('recomputes the cash effect rather than trusting the denormalised total', () => {
    /**
     * `totalValue` is a persisted derivation for the history list and CSV
     * export; SPEC-006 is explicit that the position engine must not read it,
     * because a stale or hand-edited value would otherwise reach a *preço
     * médio*. Net contributions feed SPEC-012's TWR, so the identical argument
     * applies — and this is the assertion that pins it.
     *
     * The row below has been edited to 150 units while its `totalValue` still
     * says what 100 units cost. The flow must follow the components:
     *   150 × 32,15 = 4.822,50, not the stale 3.215,00.
     */
    const edited: Transaction = {
      ...aTransaction().buy().quantity('100').price('32.15').build(),
      quantity: Quantity.fromString('150'),
    };
    expect(to8(edited.totalValue)).toBe('3215.00000000');
    expect(to8(externalFlow(edited))).toBe('4822.50000000');
  });

  it('earnings and corporate events are NOT external flows', () => {
    // The distinction SPEC-012's TWR is built on: a dividend is not money the
    // user put in, and a split moves no money at all. Counting either as a
    // contribution would make TWR stop being TWR.
    for (const transaction of [
      aTransaction().dividend().build(),
      aTransaction().jcp().build(),
      aTransaction().rendimento().build(),
      aTransaction().amortization().build(),
      aTransaction().split().ratio('2').build(),
      aTransaction().grupamento().ratio('0.1').build(),
      aTransaction().bonificacao().quantity('10').build(),
      aTransaction().adjustment().quantity('1').price('0').build(),
    ]) {
      expect(externalFlow(transaction).isZero(), transaction.type).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('BR-009-16 — the four figures on a snapshot', () => {
  /**
   * The portfolio the AC-16 assertion below rests on, priced on 2026-03-20:
   *
   *   100 PETR4          @ close 38,42        → 100 × 38,42    =  3.842,00
   *   3,5 Tesouro IPCA+  @ sell  3.413,70     → 3,5 × 3.413,70 = 11.947,95
   *   1 CDB, 110 % CDI   @ 4 business days    → 10.000 × 1,002197970588…
   *                                                            = 10.021,97970588…
   *
   *   total = 3.842,00 + 11.947,95 + 10.021,979705884156…
   *         = 15.789,95 + 10.021,979705884156…
   *         = **25.811,92970588** at NUMERIC(20,8)
   */
  function threeMethodLedger(): readonly Transaction[] {
    return [
      aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
      aTransaction()
        .buy()
        .of('Tesouro IPCA+ 2035')
        .on('2026-03-16')
        .quantity('3.5')
        .price('3200')
        .build(),
      aTransaction()
        .buy()
        .of('CDB BANCO X 2028')
        .on('2026-03-16')
        .quantity('1')
        .price('10000')
        .build(),
    ];
  }

  function seedPrices(h: Harness): void {
    h.prices.addClose(PETR4, '2026-03-20', '38.42');
    h.prices.addClose(TESOURO, '2026-03-20', '3413.70');
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));
  }

  it('AC-16: the total equals the sum of its parts across all three methods', async () => {
    const h = harness();
    seedPrices(h);
    const ledger = threeMethodLedger();
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;

    const snapshot = buildSnapshot(d('2026-03-20'), valued.value, ledger);
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');

    // The invariant itself, not a restatement of the literal: whatever the
    // three parts are, they must add to the whole. TS-12's cross-report
    // invariant starts here — the Composition report reads this breakdown and
    // the Portfolio Value endpoint reads this total.
    expect(snapshot.totalValue.equals(breakdownTotal(snapshot))).toBe(true);

    expect(to8(snapshot.byAssetClass.get('stock') ?? Money.zero())).toBe('3842.00000000');
    expect(to8(snapshot.byAssetClass.get('tesouro_direto') ?? Money.zero())).toBe('11947.95000000');
    expect(to8(snapshot.byAssetClass.get('cdb') ?? Money.zero())).toBe('10021.97970588');

    // BR-009-11: one accrued component marks the whole day's figure.
    expect(snapshot.hasEstimates).toBe(true);
  });

  it('net contributions are the external flows only; earnings are counted separately', async () => {
    const h = harness();
    seedPrices(h);
    const ledger = [
      ...threeMethodLedger(),
      // 3.215,00 + 11.200,00 + 10.000,00 = 24.415,00 contributed
      aTransaction().dividend().of('PETR4').on('2026-03-18').quantity('100').price('0.72').build(),
      aTransaction().jcp().of('PETR4').on('2026-03-19').quantity('100').price('0.31').build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    if (!valued.ok) throw new Error('valuation failed');
    const snapshot = buildSnapshot(d('2026-03-20'), valued.value, ledger);

    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
    // 100 × 0,72 + 100 × 0,31 = 72,00 + 31,00 = 103,00, recognised at pay date
    // and never assumed reinvested.
    expect(to8(snapshot.earningsToDate)).toBe('103.00000000');
    // Proventos leave the position — and therefore the total — untouched.
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');
  });

  it('BR-006-03: an unclassified row stays out of the arithmetic', async () => {
    const h = harness();
    seedPrices(h);
    const ledger = [
      ...threeMethodLedger(),
      aTransaction()
        .buy()
        .of('PETR4')
        .on('2026-03-17')
        .quantity('50')
        .price('30')
        .status('unclassified')
        .build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    if (!valued.ok) throw new Error('valuation failed');
    const snapshot = buildSnapshot(d('2026-03-20'), valued.value, ledger);
    // The 1.500,00 unclassified buy moves neither the total nor contributions.
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');
    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
  });

  it('only flows on or before the snapshot date are counted', () => {
    const ledger = [
      aTransaction().buy().on('2026-03-16').quantity('100').price('10').build(),
      aTransaction().buy().on('2026-03-25').quantity('100').price('10').build(),
    ];
    expect(to8(buildSnapshot(d('2026-03-20'), [], ledger).netContributions)).toBe('1000.00000000');
    expect(to8(buildSnapshot(d('2026-03-25'), [], ledger).netContributions)).toBe('2000.00000000');
  });
});

// ---------------------------------------------------------------------------

describe('valuePortfolioAt — dispatch, and the edges', () => {
  it('drops a position closed to zero rather than flagging it for a missing price', async () => {
    // TS-28's "zero quantity" branch. A finished holding is worth nothing, has
    // no price, and must not appear in "Needs attention" — noise there buries
    // the flags that mean something (BR-009-13).
    const h = harness();
    const ledger = [
      aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
      aTransaction().sell().of('PETR4').on('2026-03-17').quantity('100').price('38.42').build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-18'), d('2026-03-18'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-18'), 'historical');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    expect(valued.value).toEqual([]);

    const snapshot = buildSnapshot(d('2026-03-18'), valued.value, ledger);
    expect(snapshot.totalValue.isZero()).toBe(true);
    expect(snapshot.hasEstimates).toBe(false);
    // The sale still shows up as an external flow: 3.215,00 in, 3.842,00 out.
    expect(to8(snapshot.netContributions)).toBe('-627.00000000');
  });

  it('propagates a replay failure rather than valuing a ledger it cannot process', async () => {
    const h = harness();
    const ledger = [
      aTransaction().sell().of('PETR4').on('2026-03-16').quantity('100').price('38.42').build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-16'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-16'), 'historical');
    // A clamped position would produce a plausible wrong number; an error is
    // visible. The ledger's own write path refuses such a row in the first
    // place, so this is the belt to that braces.
    expect(valued.ok).toBe(false);
  });

  it('an asset the catalog does not know is an error, never a guessed class', async () => {
    const unknown = AssetId.of('0000000a-0009-7000-8000-0000000000ff');
    const context: ValuationContext = {
      calendar,
      assets: new Map(),
      contracts: new Map(),
      closes: new Map(),
      latest: new Map(),
      cdi: [],
      ipca: [],
    };
    const ledger = [
      { ...aTransaction().buy().quantity('1').price('10').build(), assetId: unknown },
    ];
    const valued = valuePortfolioAt(context, ledger, d('2026-03-16'), 'historical');
    expect(valued.ok).toBe(false);
    if (valued.ok) return;
    expect(valued.error.code).toBe(ValuationErrorCode.ASSET_NOT_FOUND);
    // AR-39: primitives only, and nothing identifying a person.
    expect(valued.error.context).toEqual({ assetId: unknown, date: '2026-03-16' });
  });

  it('tolerates a context with no price history for an asset rather than throwing', async () => {
    // A hand-built, deliberately incomplete context: the `?? []` and `?? null`
    // fallbacks must degrade to the cost-basis floor, not crash a nightly job.
    const context: ValuationContext = {
      calendar,
      assets: new Map([
        [PETR4, { id: PETR4, code: 'PETR4', name: 'Petrobras PN', assetClass: 'stock' as const }],
      ]),
      contracts: new Map(),
      closes: new Map(),
      latest: new Map(),
      cdi: [],
      ipca: [],
    };
    const ledger = [
      aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
    ];
    const valued = valuePortfolioAt(context, ledger, d('2026-03-16'), 'current');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    expect(valued.value[0]?.needsAttention).toBe(NeedsAttentionReason.PRICE_UNAVAILABLE);
    expect(to8(valued.value[0]?.value ?? Money.zero())).toBe('3215.00000000');
  });

  it('a Tesouro title absent from the price context also degrades to the cost floor', async () => {
    // The same `?? []` guard as the listed path, on the other branch of the
    // dispatch. Worth its own case: a Tesouro position falling through to a
    // throw would take down the whole nightly snapshot job, and Tesouro is the
    // class most likely to have a title `tesouro.sync` has not reached yet.
    const context: ValuationContext = {
      calendar,
      assets: new Map([
        [
          TESOURO,
          {
            id: TESOURO,
            code: 'Tesouro IPCA+ 2035',
            name: 'Tesouro IPCA+ 2035',
            assetClass: 'tesouro_direto' as const,
          },
        ],
      ]),
      contracts: new Map(),
      closes: new Map(),
      latest: new Map(),
      cdi: [],
      ipca: [],
    };
    const ledger = [
      aTransaction()
        .buy()
        .of('Tesouro IPCA+ 2035')
        .on('2026-03-16')
        .quantity('3.5')
        .price('3200')
        .build(),
    ];
    const valued = valuePortfolioAt(context, ledger, d('2026-03-16'), 'historical');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    expect(valued.value[0]?.needsAttention).toBe(NeedsAttentionReason.PRICE_UNAVAILABLE);
    expect(to8(valued.value[0]?.value ?? Money.zero())).toBe('11200.00000000');
  });

  it('a CDB with no contract is valued at cost and queued, not omitted from the total', async () => {
    const h = harness();
    // No `contracts.set(...)` — the SPEC-005 row does not exist yet.
    const ledger = [
      aTransaction()
        .buy()
        .of('CDB BANCO X 2028')
        .on('2026-03-16')
        .quantity('1')
        .price('10000')
        .build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    if (!valued.ok) throw new Error('valuation failed');
    const snapshot = buildSnapshot(d('2026-03-20'), valued.value, ledger);
    expect(to8(snapshot.totalValue)).toBe('10000.00000000');
    expect(valued.value[0]?.needsAttention).toBe(
      NeedsAttentionReason.FIXED_INCOME_CONTRACT_MISSING,
    );
  });

  it('BR-009-02: only the date declared current may read an intraday quote', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-19', '38.42');
    h.prices.setLatest(PETR4, '45.00', '2026-03-20T18:00:00Z');
    const ledger = [
      aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-19'), d('2026-03-20'));

    const historical = valuePortfolioAt(context, ledger, d('2026-03-19'), 'historical');
    const current = valuePortfolioAt(context, ledger, d('2026-03-20'), 'current');
    if (!historical.ok || !current.ok) throw new Error('valuation failed');
    expect(to8(historical.value[0]?.value ?? Money.zero())).toBe('3842.00000000');
    expect(to8(current.value[0]?.value ?? Money.zero())).toBe('4500.00000000');
  });
});

// ---------------------------------------------------------------------------

describe('loadValuationContext', () => {
  const ledger = [
    aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
  ];

  it('prepends the pre-range anchor so a carry-forward works at the range start', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-13', '37.00'); // before the range
    h.prices.addClose(PETR4, '2026-03-18', '38.42'); // inside it
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    expect(context.closes.get(PETR4)?.map((quote) => quote.date)).toEqual([
      '2026-03-13',
      '2026-03-18',
    ]);
    // Without the anchor, 16 and 17 March would fall back to cost even though
    // Friday the 13th's close is right there.
    const valued = valuePortfolioAt(context, ledger, d('2026-03-16'), 'historical');
    if (!valued.ok) throw new Error('valuation failed');
    expect(to8(valued.value[0]?.value ?? Money.zero())).toBe('3700.00000000');
    expect(valued.value[0]?.carriedForward).toBe(true);
  });

  it('does not duplicate the anchor when it is itself the first in-range close', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.00');
    h.prices.addClose(PETR4, '2026-03-18', '38.42');
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    expect(context.closes.get(PETR4)?.map((quote) => quote.date)).toEqual([
      '2026-03-16',
      '2026-03-18',
    ]);
  });

  it('keeps a lone pre-range anchor when the range itself has no closes', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-13', '37.00');
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    expect(context.closes.get(PETR4)?.map((quote) => quote.date)).toEqual(['2026-03-13']);
  });

  it('an asset with no price history at all yields an empty array, not undefined', async () => {
    const h = harness();
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    expect(context.closes.get(PETR4)).toEqual([]);
    expect(context.latest.has(PETR4)).toBe(false);
  });

  it('does not query prices or contracts for an asset the catalog does not know', async () => {
    // An unknown asset must not be silently treated as fixed income; it falls
    // through to the price path and `valuePortfolioAt` rejects it by name.
    const h = harness();
    const unknown = AssetId.of('0000000a-0009-7000-8000-0000000000fe');
    const orphan = [
      { ...aTransaction().buy().quantity('1').price('10').build(), assetId: unknown },
    ];
    const context = await loadValuationContext(h.deps, orphan, d('2026-03-16'), d('2026-03-20'));
    expect(context.assets.has(unknown)).toBe(false);
    expect(h.contracts.lookups).toEqual([]);
  });

  it('an unseeded series reads as empty, so a missing IPCA history is not a crash', async () => {
    // BCB publishes IPCA monthly and CDI daily, so a fresh deployment
    // legitimately has one and not the other. The reader must answer "no
    // points" rather than throwing — `accrual.ts` already treats an absent
    // point as a day that does not compound, and reports the gap.
    const empty = new FakeIndexSeriesReader().set('CDI', CDI);
    expect(await empty.listPoints('IPCA', d('2026-03-16'), d('2026-03-20'))).toEqual([]);
    expect(await empty.listPoints('CDI', d('2026-03-16'), d('2026-03-17'))).toHaveLength(2);
  });

  it('skips the index-series queries entirely when no contract is held', async () => {
    const h = harness();
    await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    // BR-009-07: only bank paper needs CDI or IPCA. A portfolio of equities
    // must not pay for two series queries per rebuild.
    expect(h.series.requests).toEqual([]);
  });

  it('widens the CDI window back to the earliest issue date, not the report range', async () => {
    // A CDB issued in 2024 and valued in 2026 accrues over every business day
    // since issue. A window clipped to the report range would silently drop
    // two years of compounding — the figure would still look plausible.
    const h = harness();
    h.contracts.set(aContract(CDB, { issueDate: '2024-05-02' }));
    const cdbLedger = [
      aTransaction()
        .buy()
        .of('CDB BANCO X 2028')
        .on('2024-05-02')
        .quantity('1')
        .price('10000')
        .build(),
    ];
    await loadValuationContext(h.deps, cdbLedger, d('2026-03-16'), d('2026-03-20'));
    expect(h.series.requests).toHaveLength(2);
    expect(h.series.requests.map((request) => request.code).sort()).toEqual(['CDI', 'IPCA']);
    for (const request of h.series.requests) {
      expect(request.from).toBe('2024-05-02');
      expect(request.to).toBe('2026-03-20');
    }
  });

  it('does not widen past the range start when every contract was issued later', async () => {
    const h = harness();
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-18' }));
    const cdbLedger = [
      aTransaction()
        .buy()
        .of('CDB BANCO X 2028')
        .on('2026-03-18')
        .quantity('1')
        .price('10000')
        .build(),
    ];
    await loadValuationContext(h.deps, cdbLedger, d('2026-03-16'), d('2026-03-20'));
    expect(h.series.requests[0]?.from).toBe('2026-03-16');
  });

  it('records the latest quote when one exists', async () => {
    const h = harness();
    h.prices.setLatest(PETR4, '45.00', '2026-03-20T18:00:00Z');
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    expect(context.latest.get(PETR4)?.price.toString()).toBe('45');
  });
});

// ---------------------------------------------------------------------------

describe('DM-4 / TS-08 — rebuild equals incremental', () => {
  /**
   * The single highest-value test in this file.
   *
   * `buildSnapshot` re-derives a date's flow totals from the **whole ledger**
   * up to that date. `buildSnapshotSeries` carries running totals forward and
   * adds only that day's rows — which is what a daily job actually does. The
   * two are independent implementations of the same definition, so asserting
   * they agree across a generated history catches the accumulation and
   * ordering bugs that every hand-picked example walks past.
   */
  function generatedHistory(): readonly Transaction[] {
    const history: Transaction[] = [];
    // Deliberately out of date order on arrival — the fold must not depend on
    // the sequence rows happen to arrive in (BR-007-15).
    const days = [
      '2026-03-18',
      '2026-03-16',
      '2026-03-24',
      '2026-03-17',
      '2026-03-20',
      '2026-03-19',
      '2026-03-23',
    ];
    let index = 0;
    for (const day of days) {
      index += 1;
      // Repeating decimals throughout, so any float leak shows up as drift.
      history.push(
        aTransaction()
          .buy()
          .of('PETR4')
          .on(day)
          .quantity('7')
          .price(`3${index}.33333333`)
          .fees('1.37')
          .build(),
      );
      history.push(
        aTransaction().dividend().of('PETR4').on(day).quantity('7').price('0.16666666').build(),
      );
      if (index % 3 === 0) {
        history.push(
          aTransaction()
            .sell()
            .of('PETR4')
            .on(day)
            .quantity('4')
            .price('41.11111111')
            .fees('2.15')
            .build(),
        );
      }
      if (index % 4 === 0) {
        history.push(aTransaction().split().of('PETR4').on(day).ratio('2').build());
      }
      history.push(
        aTransaction()
          .buy()
          .of('CDB BANCO X 2028')
          .on(day)
          .quantity('1')
          .price('1000.77777777')
          .build(),
      );
    }
    return history;
  }

  it('the carried-forward series equals the independently rebuilt one, day for day', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    h.prices.addClose(PETR4, '2026-03-19', '39.87');
    h.prices.addClose(PETR4, '2026-03-24', '37.03');
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));

    const ledger = generatedHistory();
    const from = d('2026-03-16');
    const to = d('2026-03-25');
    const context = await loadValuationContext(h.deps, ledger, from, to);

    const dates: BusinessDate[] = [];
    for (
      let cursor = new Date(`${from}T00:00:00Z`);
      cursor <= new Date(`${to}T00:00:00Z`);
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      dates.push(BusinessDate.of(cursor.toISOString().slice(0, 10)));
    }

    const valuedByDate = new Map(
      dates.map((date) => {
        const valued = valuePortfolioAt(context, ledger, date, 'historical');
        if (!valued.ok) throw new Error(`valuation failed on ${date}`);
        return [date, valued.value] as const;
      }),
    );

    const incremental = buildSnapshotSeries(dates, valuedByDate, ledger);
    const rebuilt = dates.map((date) => buildSnapshot(date, valuedByDate.get(date) ?? [], ledger));

    expect(incremental).toHaveLength(rebuilt.length);
    for (const [index, snapshot] of incremental.entries()) {
      const reference = rebuilt[index];
      if (reference === undefined) throw new Error('missing reference snapshot');
      // Exact structural equality on every figure, not a tolerance.
      expect(snapshotsEqual(snapshot, reference), `${snapshot.date}`).toBe(true);
      // And serialised identically, which is what actually reaches the column.
      expect(serializeSnapshot(snapshot)).toEqual(serializeSnapshot(reference));
    }

    // The property is worthless if the fixture happens to be trivial.
    expect(incremental.some((snapshot) => snapshot.totalValue.isPositive())).toBe(true);
    expect(incremental.some((snapshot) => snapshot.earningsToDate.isPositive())).toBe(true);
    expect(incremental.at(-1)?.hasEstimates).toBe(true);
  });

  it('the series is monotonic in dates and carries no state between runs', () => {
    const ledger = [aTransaction().buy().on('2026-03-16').quantity('10').price('10').build()];
    const dates = [d('2026-03-16'), d('2026-03-17')];
    const first = buildSnapshotSeries(dates, new Map(), ledger);
    const second = buildSnapshotSeries(dates, new Map(), ledger);
    expect(first.map(serializeSnapshot)).toEqual(second.map(serializeSnapshot));
    expect(first.map((snapshot) => snapshot.date)).toEqual(['2026-03-16', '2026-03-17']);
  });

  it('an empty date list produces no snapshots', () => {
    expect(buildSnapshotSeries([], new Map(), [])).toEqual([]);
  });

  it('a transaction after the last date is never consumed', () => {
    const ledger = [aTransaction().buy().on('2026-04-01').quantity('10').price('10').build()];
    const series = buildSnapshotSeries([d('2026-03-16')], new Map(), ledger);
    expect(series[0]?.netContributions.isZero()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('snapshotsEqual', () => {
  const base: DailyValuationSnapshot = {
    date: d('2026-03-20'),
    totalValue: Money.fromString('100'),
    netContributions: Money.fromString('90'),
    earningsToDate: Money.fromString('5'),
    byAssetClass: new Map([['stock', Money.fromString('100')]]),
    hasEstimates: false,
  };

  it('is true for a structurally identical snapshot reached by a different route', () => {
    expect(
      snapshotsEqual(base, {
        ...base,
        byAssetClass: new Map([['stock', Money.fromString('100')]]),
      }),
    ).toBe(true);
  });

  const cases: readonly (readonly [string, Partial<DailyValuationSnapshot>])[] = [
    ['date', { date: d('2026-03-21') }],
    ['totalValue', { totalValue: Money.fromString('101') }],
    ['netContributions', { netContributions: Money.fromString('91') }],
    ['earningsToDate', { earningsToDate: Money.fromString('6') }],
    ['hasEstimates', { hasEstimates: true }],
    ['breakdown size', { byAssetClass: new Map<AssetClass, Money>() }],
    [
      'breakdown value',
      { byAssetClass: new Map<AssetClass, Money>([['stock', Money.fromString('99')]]) },
    ],
    [
      'breakdown key',
      { byAssetClass: new Map<AssetClass, Money>([['fii', Money.fromString('100')]]) },
    ],
  ];

  it.each(cases)('is false when %s differs', (_label, patch) => {
    expect(snapshotsEqual(base, { ...base, ...patch })).toBe(false);
  });
});

describe('quantizeSnapshot — the storage boundary, and why AC-16 needs it', () => {
  /**
   * A snapshot's figures land in two different storage types: `total_value` is
   * `NUMERIC(20,8)`, which Postgres rounds to scale on write, and
   * `by_asset_class` is `jsonb`, which keeps every digit it is handed. Left
   * implicit, the same snapshot is persisted at two precisions and the parts
   * stop adding up to the total — the Composition report and the Portfolio
   * Value endpoint disagreeing by up to 1e-8 per class, which is TS-12's
   * cross-report invariant broken by a storage detail.
   */
  it('makes the total exactly the sum of the quantised parts', () => {
    // Three classes whose exact values each carry a ninth decimal place:
    //   cdb             10021.979705884156…  → 10021.97970588 (…41 rounds down)
    //   stock            3842.000000005      →  3842.00000001 (…5  rounds up)
    //   tesouro_direto  11947.949999995      → 11947.95000000 (…5  rounds up)
    // sum of quantised = 10021.97970588 + 3842.00000001 + 11947.95000000
    //                  = 25811.92970589
    const snapshot: DailyValuationSnapshot = {
      date: d('2026-03-20'),
      totalValue: Money.fromString('0'), // deliberately wrong; must be recomputed
      netContributions: Money.fromString('24415.000000004'),
      earningsToDate: Money.fromString('103.000000006'),
      byAssetClass: new Map<AssetClass, Money>([
        ['cdb', Money.fromString('10021.97970588415656252996632310492899145')],
        ['stock', Money.fromString('3842.000000005')],
        ['tesouro_direto', Money.fromString('11947.949999995')],
      ]),
      hasEstimates: true,
    };

    const quantized = quantizeSnapshot(snapshot);
    expect(quantized.byAssetClass.get('cdb')?.toString()).toBe('10021.97970588');
    expect(quantized.byAssetClass.get('stock')?.toString()).toBe('3842.00000001');
    expect(quantized.byAssetClass.get('tesouro_direto')?.toString()).toBe('11947.95');
    expect(quantized.totalValue.toString()).toBe('25811.92970589');

    // AC-16, exactly rather than approximately.
    expect(quantized.totalValue.equals(breakdownTotal(quantized))).toBe(true);
  });

  it('rounds half-up, matching what Postgres does when it reduces a NUMERIC to scale', () => {
    // Choosing any other mode would make the explicit quantisation and the
    // column fight each other, reintroducing the discrepancy it exists to
    // remove. 0,000000005 is the exact tie.
    const snapshot: DailyValuationSnapshot = {
      date: d('2026-03-20'),
      totalValue: Money.zero(),
      netContributions: Money.fromString('0.000000005'),
      earningsToDate: Money.fromString('0.000000004'),
      byAssetClass: new Map<AssetClass, Money>(),
      hasEstimates: false,
    };
    const quantized = quantizeSnapshot(snapshot);
    expect(quantized.netContributions.toString()).toBe('0.00000001');
    expect(quantized.earningsToDate.toString()).toBe('0');
  });

  it('is idempotent — quantising an already-quantised snapshot changes nothing', () => {
    // What makes a second rebuild byte-identical to the first (DM-4).
    const snapshot: DailyValuationSnapshot = {
      date: d('2026-03-20'),
      totalValue: Money.zero(),
      netContributions: Money.fromString('24415.00000001'),
      earningsToDate: Money.fromString('103'),
      byAssetClass: new Map<AssetClass, Money>([['stock', Money.fromString('3842.12345678')]]),
      hasEstimates: false,
    };
    const once = quantizeSnapshot(snapshot);
    const twice = quantizeSnapshot(once);
    expect(snapshotsEqual(once, twice)).toBe(true);
    expect(serializeSnapshot(once)).toEqual(serializeSnapshot(twice));
  });

  it('an empty breakdown quantises to a zero total, not a stale one', () => {
    const quantized = quantizeSnapshot({
      date: d('2026-03-20'),
      totalValue: Money.fromString('999'),
      netContributions: Money.zero(),
      earningsToDate: Money.zero(),
      byAssetClass: new Map<AssetClass, Money>(),
      hasEstimates: false,
    });
    expect(quantized.totalValue.isZero()).toBe(true);
  });
});

describe('AR-10 — the JSON boundary', () => {
  it('serialises every figure as a plain decimal string, never a number', () => {
    const snapshot: DailyValuationSnapshot = {
      date: d('2026-03-20'),
      totalValue: Money.fromString('25811.92970588415656'),
      netContributions: Money.fromString('24415'),
      earningsToDate: Money.fromString('103'),
      byAssetClass: new Map([
        ['cdb', Money.fromString('10021.97970588415656')],
        ['stock', Money.fromString('3842')],
      ]),
      hasEstimates: true,
    };
    const serialized = serializeSnapshot(snapshot);
    expect(serialized).toEqual({
      date: '2026-03-20',
      totalValue: '25811.92970588415656',
      netContributions: '24415',
      earningsToDate: '103',
      byAssetClass: { cdb: '10021.97970588415656', stock: '3842' },
      hasEstimates: true,
    });
    // The property that matters: it survives a JSON round trip with every
    // digit intact. `JSON.stringify` on a Decimal would have returned a float
    // and quietly lost the tail.
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
    expect(roundTripped.totalValue).toBe('25811.92970588415656');
    for (const value of Object.values(roundTripped.byAssetClass)) {
      expect(typeof value).toBe('string');
    }
  });

  it('reads a jsonb breakdown back as Money, in a deterministic order', () => {
    // Postgres does not promise key order out of a `jsonb` column, so the
    // ordering has to be imposed on read. Both directions are exercised: keys
    // arriving out of order must be sorted, and keys arriving already sorted
    // must be left alone rather than reversed.
    const outOfOrder = deserializeAssetClassBreakdown({
      stock: '3842',
      cdb: '10021.97970588415656',
    });
    expect([...outOfOrder.keys()]).toEqual(['cdb', 'stock']);
    expect(outOfOrder.get('cdb')?.toString()).toBe('10021.97970588415656');

    const alreadyOrdered = deserializeAssetClassBreakdown({
      cdb: '10021.97970588415656',
      stock: '3842',
      tesouro_direto: '11947.95',
    });
    expect([...alreadyOrdered.keys()]).toEqual(['cdb', 'stock', 'tesouro_direto']);
    expect(alreadyOrdered.get('tesouro_direto')?.toString()).toBe('11947.95');
  });
});

// ---------------------------------------------------------------------------

describe('BR-009-18 / AC-15 — invalidate and rebuild forward from a date', () => {
  const ledger = [
    aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
  ];

  it('persists one snapshot per calendar day in the range', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    const result = await rebuildSnapshots(h.deps, ledger, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((snapshot) => snapshot.date)).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
    ]);
    expect(h.snapshots.rows.size).toBe(3);
    // BR-009-18: the range is cleared before it is rewritten, so a period
    // whose transactions were all deleted does not leave orphaned rows
    // claiming a value with no ledger under it.
    expect(h.snapshots.deleteCalls).toEqual(['2026-03-16']);
  });

  it('valuing today may use the intraday quote while every earlier date may not', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    h.prices.setLatest(PETR4, '45.00', '2026-03-18T18:00:00Z');
    const result = await rebuildSnapshots(h.deps, ledger, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
      currentDate: d('2026-03-18'),
    });
    if (!result.ok) throw new Error('rebuild failed');
    expect(to8(result.value[0]?.totalValue ?? Money.zero())).toBe('3842.00000000');
    expect(to8(result.value[1]?.totalValue ?? Money.zero())).toBe('3842.00000000');
    expect(to8(result.value[2]?.totalValue ?? Money.zero())).toBe('4500.00000000');
  });

  it('a backdated edit changes the historical figures, not just today’s', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');

    const before = await rebuildSnapshots(h.deps, ledger, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
    });
    if (!before.ok) throw new Error('rebuild failed');
    expect(to8(before.value[0]?.totalValue ?? Money.zero())).toBe('3842.00000000');

    // The user corrects the quantity from 100 to 150, two days after the fact.
    const corrected = [{ ...(ledger[0] as Transaction), quantity: Quantity.fromString('150') }];
    const after = await rebuildSnapshots(h.deps, corrected, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
    });
    if (!after.ok) throw new Error('rebuild failed');
    // 150 × 38,42 = 5.763,00 — on the *earliest* date, which is the whole point.
    expect(to8(after.value[0]?.totalValue ?? Money.zero())).toBe('5763.00000000');
    expect(to8(after.value[2]?.totalValue ?? Money.zero())).toBe('5763.00000000');
  });

  it('AR-19: rebuilding the same range twice leaves the same rows, not duplicates', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    const range = { from: d('2026-03-16'), to: d('2026-03-18') };
    const first = await rebuildSnapshots(h.deps, ledger, range);
    const second = await rebuildSnapshots(h.deps, ledger, range);
    if (!first.ok || !second.ok) throw new Error('rebuild failed');
    expect(h.snapshots.rows.size).toBe(3);
    expect(first.value.map(serializeSnapshot)).toEqual(second.value.map(serializeSnapshot));
  });

  it('propagates a valuation failure without writing a partial range', async () => {
    const h = harness();
    const bad = [
      aTransaction().sell().of('PETR4').on('2026-03-16').quantity('100').price('38.42').build(),
    ];
    const result = await rebuildSnapshots(h.deps, bad, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
    });
    expect(result.ok).toBe(false);
    expect(h.snapshots.rows.size).toBe(0);
    expect(h.snapshots.deleteCalls).toEqual([]);
  });

  it('an inverted range writes nothing but still clears', async () => {
    const h = harness();
    const result = await rebuildSnapshots(h.deps, ledger, {
      from: d('2026-03-20'),
      to: d('2026-03-18'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('invalidation on its own reports how much history it dropped', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    await rebuildSnapshots(h.deps, ledger, { from: d('2026-03-16'), to: d('2026-03-20') });
    expect(h.snapshots.rows.size).toBe(5);

    const dropped = await invalidateSnapshotsFrom(h.deps, d('2026-03-18'));
    // 18, 19 and 20 go; 16 and 17 stay. "Invalidated three days" is worth
    // logging, and is a different event from "nothing to invalidate".
    expect(dropped).toBe(3);
    expect([...h.snapshots.rows.keys()].sort()).toEqual(['2026-03-16', '2026-03-17']);
    expect(await invalidateSnapshotsFrom(h.deps, d('2026-04-01'))).toBe(0);
  });

  it('listRange reads back what was written, in date order', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '38.42');
    await rebuildSnapshots(h.deps, ledger, { from: d('2026-03-16'), to: d('2026-03-20') });
    const rows = await h.snapshots.listRange(d('2026-03-17'), d('2026-03-19'));
    expect(rows.map((snapshot) => snapshot.date)).toEqual([
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
    ]);
  });
});
