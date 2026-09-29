import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { costsCarriedOut } from '@/core/positions/carried-out';
import { type AmortizationTerms, amortizationTermsOf } from '@/core/positions/amortization';
import {
  type CarryLeg,
  resolveCarriedCosts,
  withCarriedCost,
} from '@/core/ingestion/transfer-cost';
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
  computeSnapshots,
  deserializeAssetClassBreakdown,
  distinctAssetIds,
  earliestTradeDate,
  externalFlow,
  invalidateSnapshotsFrom,
  pairedTransferIds,
  quantizeSnapshot,
  loadValuationContext,
  persistSnapshots,
  rebuildSnapshots,
  serializeSnapshot,
  snapshotsEqual,
  valuePortfolioAt,
  withTransferCloses,
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

/** A builder that must succeed here; a failure names its code. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}
const d = (value: string): BusinessDate => BusinessDate.of(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

const PETR4 = assetIdFor('PETR4');
const TESOURO = assetIdFor('Tesouro IPCA+ 2035');
const CDB = assetIdFor('CDB BANCO X 2028');
const VALE3 = assetIdFor('VALE3');

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
  // #183: a listed asset no test gives a close — the COST_FALLBACK path.
  assets.add({ id: VALE3, code: 'VALE3', name: 'Vale ON', assetClass: 'stock' });
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
    // SPEC-013 BR-013-08: a transfer in at the cost it opens its lot with —
    // 100 × 32,15 carried + 1,20 of fees = 3.216,20, what applyAcquisition adds.
    const credit = aTransaction().transferIn().quantity('100').price('32.15').fees('1.20').build();
    expect(to8(externalFlow(credit))).toBe('3216.20000000');
  });

  it('sells are negative, net of the fees they cost', () => {
    // 100 × 38,42 − 4,90 = 3.837,10 leaving the portfolio.
    const sell = aTransaction().sell().quantity('100').price('38.42').fees('4.90').build();
    expect(to8(externalFlow(sell))).toBe('-3837.10000000');
  });

  it('SPEC-013 BR-013-08: a transfer out flows out at the cost it carries, never at its stated price', () => {
    // B3's debit is price-less (unit_price 0). Read from the row it flowed
    // R$ 0 — #181. The cost is what the source position gives up, 3.215,00.
    const priceless = aTransaction().transferOut().quantity('100').price('0').build();
    expect(to8(externalFlow(priceless, Money.fromString('3215')))).toBe('-3215.00000000');
    // A stray price on the debit is not a cost: 100 × 99,00 is ignored.
    const priced = aTransaction().transferOut().quantity('100').price('99').build();
    expect(to8(externalFlow(priced, Money.fromString('3215')))).toBe('-3215.00000000');
    // A fee offsets the outflow, as a sale's fee offsets its proceeds:
    // −(3.215,00 − 2,50) = −3.212,50.
    const withFee = aTransaction().transferOut().quantity('100').price('0').fees('2.50').build();
    expect(to8(externalFlow(withFee, Money.fromString('3215')))).toBe('-3212.50000000');
  });

  it('a transfer out with no carried cost is refused, never flowed as zero', () => {
    expect(() => externalFlow(aTransaction().transferOut().build())).toThrow(RangeError);
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
      aTransaction().fracaoBonificacao().quantity('0.2').build(),
      aTransaction().leilaoFracoes().quantity('0.2').price('14.00').build(),
      aTransaction().adjustment().quantity('1').price('0').build(),
    ]) {
      expect(externalFlow(transaction).isZero(), transaction.type).toBe(true);
    }
  });

  it('BR-007-05b (#143) — a conversion leg is never an external flow, even carrying a price', () => {
    // A conversion carries cost and never cash, so neither leg moves money in
    // or out of the portfolio. A stray price on an out leg — 90 × 2,239 − 0,51
    // would be 201,00 as a sale — still flows 0,00: the price is not cash.
    const pricedOut = aTransaction()
      .conversionOut('00000000-c0de-7000-8000-000000000041', '9000')
      .quantity('90')
      .price('2.239')
      .fees('0.51')
      .build();
    expect(to8(externalFlow(pricedOut))).toBe('0.00000000');
    // Nor a stored total: a hand-set 201,00 is not read (recomputed, not trusted).
    expect(to8(externalFlow({ ...pricedOut, totalValue: Money.fromString('201') }))).toBe(
      '0.00000000',
    );
    const plainOut = aTransaction().conversionOut().quantity('100').build();
    expect(to8(externalFlow(plainOut))).toBe('0.00000000');
    const incoming = aTransaction().conversionIn('9000').quantity('83.89').build();
    expect(to8(externalFlow(incoming))).toBe('0.00000000');
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

    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));
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
    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));

    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
    // 100 × 0,72 + 100 × 0,31 = 72,00 + 31,00 = 103,00, recognised at pay date
    // and never assumed reinvested.
    expect(to8(snapshot.earningsToDate)).toBe('103.00000000');
    // Proventos leave the position — and therefore the total — untouched.
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');
  });

  it('SPEC-014 BR-014-01: a leilão de frações counts in earnings, not contributions', async () => {
    const h = harness();
    seedPrices(h);
    const ledger = [
      ...threeMethodLedger(),
      aTransaction().dividend().of('PETR4').on('2026-03-18').quantity('100').price('0.72').build(),
      aTransaction()
        .leilaoFracoes()
        .of('PETR4')
        .on('2026-03-19')
        .quantity('0.2')
        .price('14.00')
        .build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    if (!valued.ok) throw new Error('valuation failed');
    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));

    // 100 × 0,72 + 0,2 × 14,00 = 72,00 + 2,80 = 74,80
    expect(to8(snapshot.earningsToDate)).toBe('74.80000000');
    // Contributions unchanged from the three buys: 24.415,00.
    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
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
    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));
    // The 1.500,00 unclassified buy moves neither the total nor contributions.
    expect(to8(snapshot.totalValue)).toBe('25811.92970588');
    expect(to8(snapshot.netContributions)).toBe('24415.00000000');
  });

  it('only flows on or before the snapshot date are counted', () => {
    const ledger = [
      aTransaction().buy().on('2026-03-16').quantity('100').price('10').build(),
      aTransaction().buy().on('2026-03-25').quantity('100').price('10').build(),
    ];
    expect(to8(unwrap(buildSnapshot(d('2026-03-20'), [], ledger)).netContributions)).toBe(
      '1000.00000000',
    );
    expect(to8(unwrap(buildSnapshot(d('2026-03-25'), [], ledger)).netContributions)).toBe(
      '2000.00000000',
    );
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

    const snapshot = unwrap(buildSnapshot(d('2026-03-18'), valued.value, ledger));
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
    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));
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
      // SPEC-013 BR-013-08: a transfer's flow is read off its source position,
      // so the two builders must also agree on *that* — one folding the costs
      // per date from a cut ledger, the other once. Pushed ahead of the day's
      // buy and split, so replay order, not arrival order, decides the average
      // each debit carries; the credits carry repeating prices into XP, and
      // XP later sends three of its shares out one-sided.
      if (index % 2 === 0) {
        history.push(
          aTransaction().transferOut().of('PETR4').on(day).quantity('2').price('0').build(),
          aTransaction()
            .transferIn()
            .of('PETR4')
            .at('XP')
            .on(day)
            .quantity('2')
            .price(`2${index}.14285714`)
            .build(),
        );
      }
      if (index === 7) {
        history.push(
          aTransaction()
            .transferOut()
            .of('PETR4')
            .at('XP')
            .on(day)
            .quantity('3')
            .price('0')
            .build(),
        );
      }
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
      // #183 — the shapes SPEC-013 BR-013-08 now tells apart. The null-
      // institution debits above pair with nothing (BR-005-20a wants a known
      // source), so they and their XP credits are *unpaired*, valued at market
      // on `market_flows`. Clear → XP moves are *paired*, and their credits
      // carry a price that is not the carried cost (the #145 shape): internal
      // on both figures whatever it says.
      history.push(
        aTransaction()
          .buy()
          .of('PETR4')
          .at('Clear')
          .on(day)
          .quantity('5')
          .price(`1${index}.66666666`)
          .build(),
      );
      if (index % 2 === 0) {
        history.push(
          aTransaction()
            .transferOut()
            .of('PETR4')
            .at('Clear')
            .on(day)
            .quantity('3')
            .price('0')
            .build(),
          aTransaction()
            .transferIn()
            .of('PETR4')
            .at('XP')
            .on(day)
            .quantity('3')
            .price(`1${index}.77777777`)
            .build(),
        );
      }
      // Missing closes: VALE3 has none at all, so its unpaired legs are valued
      // at cost and marked estimated (COST_FALLBACK); bank paper arriving
      // from outside is accrued, an estimate by nature.
      if (day === '2026-03-16') {
        history.push(
          aTransaction()
            .transferIn()
            .of('VALE3')
            .at('XP')
            .on(day)
            .quantity('10')
            .price('50.33333333')
            .build(),
        );
      }
      if (day === '2026-03-19') {
        history.push(
          aTransaction()
            .transferOut()
            .of('VALE3')
            .at('XP')
            .on(day)
            .quantity('4')
            .price('0')
            .build(),
        );
      }
      if (day === '2026-03-17') {
        history.push(
          aTransaction()
            .transferIn()
            .of('CDB BANCO X 2028')
            .at('XP')
            .on(day)
            .quantity('1')
            .price('999.99999999')
            .build(),
        );
      }
    }
    // A Saturday arrival, valued at Thursday's close carried forward (BR-009-03).
    history.push(
      aTransaction()
        .transferIn()
        .of('PETR4')
        .at('Rico')
        .on('2026-03-21')
        .quantity('1')
        .price('30.5')
        .build(),
    );
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

    const incremental = unwrap(buildSnapshotSeries(dates, valuedByDate, ledger, { context }));
    const rebuilt = dates.map((date) =>
      unwrap(buildSnapshot(date, valuedByDate.get(date) ?? [], ledger, { context })),
    );

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
    const carried = costsCarriedOut(ledger);
    expect(carried.ok && [...carried.value.values()].every((cost) => cost.isPositive())).toBe(true);
    // 3 null-institution debits, 3 Clear debits, XP's one-sided 3, VALE3's 4.
    expect(carried.ok && carried.value.size).toBe(8);
    // 3 Clear → XP pairs, both legs each; every other transfer is unpaired.
    expect(pairedTransferIds(ledger).size).toBe(6);
    // The two figures genuinely diverge, so the property covers market_flows.
    expect(
      incremental.some((snapshot) => !snapshot.marketFlows.equals(snapshot.netContributions)),
    ).toBe(true);
    expect(incremental.some((snapshot) => snapshot.totalValue.isPositive())).toBe(true);
    expect(incremental.some((snapshot) => snapshot.earningsToDate.isPositive())).toBe(true);
    expect(incremental.at(-1)?.hasEstimates).toBe(true);
  });

  it('the series is monotonic in dates and carries no state between runs', () => {
    const ledger = [aTransaction().buy().on('2026-03-16').quantity('10').price('10').build()];
    const dates = [d('2026-03-16'), d('2026-03-17')];
    const first = unwrap(buildSnapshotSeries(dates, new Map(), ledger));
    const second = unwrap(buildSnapshotSeries(dates, new Map(), ledger));
    expect(first.map(serializeSnapshot)).toEqual(second.map(serializeSnapshot));
    expect(first.map((snapshot) => snapshot.date)).toEqual(['2026-03-16', '2026-03-17']);
  });

  it('an empty date list produces no snapshots', () => {
    expect(unwrap(buildSnapshotSeries([], new Map(), []))).toEqual([]);
  });

  it('a transaction after the last date is never consumed', () => {
    const ledger = [aTransaction().buy().on('2026-04-01').quantity('10').price('10').build()];
    const series = unwrap(buildSnapshotSeries([d('2026-03-16')], new Map(), ledger));
    expect(series[0]?.netContributions.isZero()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('snapshotsEqual', () => {
  const base: DailyValuationSnapshot = {
    date: d('2026-03-20'),
    totalValue: Money.fromString('100'),
    netContributions: Money.fromString('90'),
    marketFlows: Money.fromString('90'), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
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
    ['marketFlows', { marketFlows: Money.fromString('95') }],
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
      marketFlows: Money.fromString('24415.000000004'), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
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
      marketFlows: Money.fromString('0.000000005'), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
      earningsToDate: Money.fromString('0.000000004'),
      byAssetClass: new Map<AssetClass, Money>(),
      hasEstimates: false,
    };
    const quantized = quantizeSnapshot(snapshot);
    expect(quantized.netContributions.toString()).toBe('0.00000001');
    expect(quantized.marketFlows.toString()).toBe('0.00000001');
    expect(quantized.earningsToDate.toString()).toBe('0');
  });

  it('is idempotent — quantising an already-quantised snapshot changes nothing', () => {
    // What makes a second rebuild byte-identical to the first (DM-4).
    const snapshot: DailyValuationSnapshot = {
      date: d('2026-03-20'),
      totalValue: Money.zero(),
      netContributions: Money.fromString('24415.00000001'),
      marketFlows: Money.fromString('24415.00000001'), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
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
      marketFlows: Money.zero(), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
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
      marketFlows: Money.fromString('24500.5'),
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
      marketFlows: '24500.5',
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

  it('BR-009-17/18: persistSnapshots deletes from the given date, or everything when none', async () => {
    const snapshot = (date: string): DailyValuationSnapshot => ({
      date: d(date),
      totalValue: Money.fromString('1'),
      netContributions: Money.fromString('1'),
      marketFlows: Money.fromString('1'), // SPEC-013 BR-013-08: no unpaired transfer here, so equal to netContributions
      earningsToDate: Money.zero(),
      byAssetClass: new Map(),
      hasEstimates: false,
    });
    const h = harness();
    await h.snapshots.upsertMany(['2026-03-10', '2026-03-16', '2026-03-17'].map(snapshot));

    // Scoped: deletion starts at the requested date, which may be earlier than
    // the first snapshot written — an orphan between the two goes too.
    await persistSnapshots(h.snapshots, [snapshot('2026-03-17')], d('2026-03-16'));
    expect([...h.snapshots.rows.keys()]).toEqual(['2026-03-10', '2026-03-17']);
    expect(h.snapshots.deleteAllCalls).toBe(0);

    // Whole history: nothing before the new series survives either.
    await persistSnapshots(h.snapshots, [snapshot('2026-03-17')], null);
    expect([...h.snapshots.rows.keys()]).toEqual(['2026-03-17']);
    expect(h.snapshots.deleteAllCalls).toBe(1);
    expect(h.snapshots.deleteCalls).toEqual(['2026-03-16']);

    // An empty series (a tenant whose ledger is gone) still invalidates.
    await persistSnapshots(h.snapshots, [], null);
    expect(h.snapshots.rows.size).toBe(0);
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

describe('SPEC-007 BR-007-05c — valuation replays amortizations with the context’s own catalogue', () => {
  it('a restitution lowers cost basis, not value, and stays earnings rather than a flow', async () => {
    // Buy 100 PETR4 @ 32,15 on 2026-03-16 → cost 3.215,00.
    // Restitution 100 × 0,50 = 50,00 on 2026-03-18 → cost 3.165,00 (31,65).
    // Close on 2026-03-20: 38,42 → value 100 × 38,42 = 3.842,00.
    // Unrealized 3.842,00 − 3.165,00 = 677,00.
    // Net contributions 3.215,00 (the restitution is not an external flow);
    // earnings to date 50,00 (SPEC-014 BR-014-01 unchanged).
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-20', '38.42');
    const ledger = [
      aTransaction().buy().of('PETR4').on('2026-03-16').quantity('100').price('32.15').build(),
      aTransaction()
        .amortization()
        .of('PETR4')
        .on('2026-03-18')
        .quantity('100')
        .price('0.50')
        .build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    const [petr4] = valued.value;
    expect(to8(petr4?.value ?? Money.zero())).toBe('3842.00000000');
    expect(to8(petr4?.costBasis ?? Money.zero())).toBe('3165.00000000');
    expect(to8(petr4?.unrealizedGain ?? Money.zero())).toBe('677.00000000');

    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), valued.value, ledger));
    expect(to8(snapshot.netContributions)).toBe('3215.00000000');
    expect(to8(snapshot.earningsToDate)).toBe('50.00000000');
  });

  it('an amortization of a Tesouro title with no BR-007-05c rule fails the valuation', async () => {
    // Tesouro IPCA+ 2035 is not NTN-B1: no principal is defined, so no
    // figure is produced for the day rather than one resting on a guess.
    const h = harness();
    const ledger = [
      aTransaction()
        .buy()
        .of('Tesouro IPCA+ 2035')
        .on('2026-03-16')
        .quantity('1')
        .price('3400')
        .build(),
      aTransaction()
        .amortization()
        .of('Tesouro IPCA+ 2035')
        .on('2026-03-18')
        .quantity('1')
        .price('50')
        .build(),
    ];
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-20'), d('2026-03-20'));
    const valued = valuePortfolioAt(context, ledger, d('2026-03-20'), 'historical');
    expect(valued.ok).toBe(false);
    if (valued.ok) return;
    expect(valued.error.code).toBe('AMORTIZATION_NOT_SUPPORTED');
  });
});

// ---------------------------------------------------------------------------

describe('SPEC-013 BR-013-08 / DL-013-08, DL-013-09 — a transfer flows at the cost it carries, and a pair not at all', () => {
  /** Net contributions on `date`, from scratch, at full precision. */
  function contributionsOn(
    ledger: readonly Transaction[],
    date: string,
    options: Parameters<typeof buildSnapshot>[3] = {},
  ): Money {
    return unwrap(buildSnapshot(d(date), [], ledger, options)).netContributions;
  }

  /** Market flows on `date`, for a ledger whose transfers all pair (no prices needed). */
  function marketFlowsOn(ledger: readonly Transaction[], date: string): Money {
    return unwrap(buildSnapshot(d(date), [], ledger)).marketFlows;
  }

  /** The snapshot on `date` from scratch, with PETR4 closing at `closes`. */
  async function flowsOn(
    ledger: readonly Transaction[],
    date: string,
    closes: readonly (readonly [string, string])[],
  ): Promise<DailyValuationSnapshot> {
    const h = harness();
    for (const [on, close] of closes) h.prices.addClose(PETR4, on, close);
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-01'), d(date));
    return unwrap(buildSnapshot(d(date), [], ledger, { context }));
  }

  it('an inter-broker pair nets to exactly zero, on repeating and terminating averages alike', () => {
    // Three moves Clear → XP, each credit carrying round₈ of the source's
    // preço médio (SPEC-005 BR-005-20a / withCarriedCost):
    //
    //   PETR4  buy 7 @ 18,99 + 0,03        → 132,96;    avg 18,99428571428…
    //          debit  −7 × 18,99428571     = −132,95999997
    //          credit +7 × 18,99428571     = +132,95999997
    //   ITSA4  buy 128 @ 11,42 + 0,06      → 1.461,82;  avg 11,42046875
    //          debit −1.461,82, credit +1.461,82
    //   BBAS3  buy 800 @ 22,13 + 6,61      → 17.710,61; avg 22,1382625
    //          sell 345 @ 25,00            → −8.625,00 (average unchanged)
    //          debit  −455 × 22,13826250   = −10.072,9094375
    //          credit +455 × 22,13826250   = +10.072,9094375
    //
    //   net = 132,96 + 1.461,82 + 17.710,61 − 8.625,00 = 10.680,39
    //
    // Before #181 the debits flowed R$ 0 and this read 10.680,39 + 132,95999997
    // + 1.461,82 + 10.072,9094375 = 22.348,07943747. With the debit at its
    // unrounded cost the PETR4 pair alone would leave −0,00000003.
    const ledger = [
      aTransaction()
        .buy()
        .of('PETR4')
        .at('Clear')
        .on('2026-03-02')
        .quantity('7')
        .price('18.99')
        .fees('0.03')
        .build(),
      aTransaction()
        .transferOut()
        .of('PETR4')
        .at('Clear')
        .on('2026-03-10')
        .quantity('7')
        .price('0')
        .build(),
      aTransaction()
        .transferIn()
        .of('PETR4')
        .at('XP')
        .on('2026-03-10')
        .quantity('7')
        .price('18.99428571')
        .build(),
      aTransaction()
        .buy()
        .of('ITSA4')
        .at('Clear')
        .on('2026-03-02')
        .quantity('128')
        .price('11.42')
        .fees('0.06')
        .build(),
      aTransaction()
        .transferOut()
        .of('ITSA4')
        .at('Clear')
        .on('2026-03-10')
        .quantity('128')
        .price('0')
        .build(),
      aTransaction()
        .transferIn()
        .of('ITSA4')
        .at('XP')
        .on('2026-03-10')
        .quantity('128')
        .price('11.42046875')
        .build(),
      aTransaction()
        .buy()
        .of('BBAS3')
        .at('Clear')
        .on('2026-03-02')
        .quantity('800')
        .price('22.13')
        .fees('6.61')
        .build(),
      aTransaction()
        .sell()
        .of('BBAS3')
        .at('Clear')
        .on('2026-03-05')
        .quantity('345')
        .price('25')
        .build(),
      aTransaction()
        .transferOut()
        .of('BBAS3')
        .at('Clear')
        .on('2026-03-10')
        .quantity('455')
        .price('0')
        .build(),
      aTransaction()
        .transferIn()
        .of('BBAS3')
        .at('XP')
        .on('2026-03-10')
        .quantity('455')
        .price('22.1382625')
        .build(),
    ];
    const before = contributionsOn(ledger, '2026-03-09');
    const after = contributionsOn(ledger, '2026-03-10');
    // Exact, not to eight places: the pairs contribute nothing at all.
    expect(before.toString()).toBe('10680.39');
    expect(after.toString()).toBe('10680.39');
    // And what reaches the column is the same figure.
    const stored = quantizeSnapshot(unwrap(buildSnapshot(d('2026-03-10'), [], ledger)));
    expect(stored.netContributions.toString()).toBe('10680.39');
    // The accumulating series agrees on the transfer date (DM-4).
    const series = unwrap(
      buildSnapshotSeries([d('2026-03-09'), d('2026-03-10')], new Map(), ledger),
    );
    expect(series.map((snapshot) => snapshot.netContributions.toString())).toEqual([
      '10680.39',
      '10680.39',
    ]);
  });

  it('an unpaired transfer in: net contributions at the cost it opens with, market flows at the close', async () => {
    // Shares arriving from outside the portfolio (#183, SPEC-013 BR-013-08):
    //   net    100 × 25,00 + 1,50 of fees = +2.501,50 — what the lot opens at
    //   market 100 × 26,00 (close 10/03)  = +2.600,00 — what arrived; the fee
    //          is not part of what moved (GIPS in-kind flow)
    const ledger = [
      aTransaction()
        .transferIn()
        .at('XP')
        .on('2026-03-10')
        .quantity('100')
        .price('25')
        .fees('1.50')
        .build(),
    ];
    const snapshot = await flowsOn(ledger, '2026-03-10', [['2026-03-10', '26']]);
    expect(snapshot.netContributions.toString()).toBe('2501.5');
    expect(snapshot.marketFlows.toString()).toBe('2600');
    // An observed close: nothing about the day is an estimate.
    expect(snapshot.hasEstimates).toBe(false);
  });

  it('an unpaired transfer out: net contributions at the cost it takes away, market flows at the close', async () => {
    //   buy 100 @ 10,00 + 5,00 fees → +1.005,00 on both figures, average 10,05
    //   transfer_out 40 (to someone else's custody, price-less), close 12,00
    //     net    −40 × 10,05 = −402,00 → 1.005,00 − 402,00 = 603,00 (cost still held)
    //     market −40 × 12,00 = −480,00 → 1.005,00 − 480,00 = 525,00
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('100')
        .price('10')
        .fees('5')
        .build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('40').price('0').build(),
    ];
    const snapshot = await flowsOn(ledger, '2026-03-10', [['2026-03-10', '12']]);
    expect(snapshot.netContributions.toString()).toBe('603');
    expect(snapshot.marketFlows.toString()).toBe('525');
  });

  it('#135: a same-institution round trip nets to zero, one leg or two of each', () => {
    //   buy 3 @ 3,33 + 0,01 at Clear → +10,00 on both figures
    //   same day, at Clear: credit 3 and debit 3 pair one-to-one (SPEC-005
    //   BR-005-20a), so the pair is internal and adds nothing to either
    //   figure (#183, DL-013-09): both stay 10,00. #181 reached the same
    //   10,00 on net contributions leg by leg — credit +3 × 3,33333333 =
    //   +9,99999999, debit −3 × round₈(A′) = −9,99999999.
    const single = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      aTransaction()
        .transferIn()
        .at('Clear')
        .on('2026-03-10')
        .quantity('3')
        .price('3.33333333')
        .build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('3').price('0').build(),
    ];
    expect(contributionsOn(single, '2026-03-10').toString()).toBe('10');
    expect(marketFlowsOn(single, '2026-03-10').toString()).toBe('10');

    // The #145 follow-up shape: two carried (price-less, import-written)
    // credits and two debits of one quantity at one broker. No one-to-one
    // pair forms, but the round-trip rule pairs them in id order — every leg
    // internal, both figures 10,00, and no price needed at all.
    const carriedCredit = () =>
      aTransaction()
        .transferIn()
        .at('Clear')
        .on('2026-03-10')
        .quantity('3')
        .price('3.33333333')
        .imported()
        .build();
    const double = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      carriedCredit(),
      carriedCredit(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('3').price('0').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('3').price('0').build(),
    ];
    expect(pairedTransferIds(double).size).toBe(4);
    expect(contributionsOn(double, '2026-03-10').toString()).toBe('10');
    expect(marketFlowsOn(double, '2026-03-10').toString()).toBe('10');
  });

  it('#145 follow-up: a round trip with a priced credit pairs nothing, and its legs still cancel', async () => {
    // BR-005-20a: a credit with a price of its own breaks the round trip, so
    // all four legs are unpaired and each is valued on its own. On one asset
    // and one date the market legs cancel exactly:
    //   net    both credits apply first (rank 0): Clear holds 9 costing
    //          10,00 + 3 × 3,33333333 + 3 × 3,50 = 30,49999999,
    //          A′ = 3,388888887777…, round₈ = 3,38888889 → each debit 10,16666667
    //          = 10,00 + 9,99999999 + 10,50 − 2 × 10,16666667 = 10,16666665
    //   market 10,00 + 2 × 3 × 3,40 − 2 × 3 × 3,40 = 10,00 (close 3,40)
    const ledger = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      aTransaction()
        .transferIn()
        .at('Clear')
        .on('2026-03-10')
        .quantity('3')
        .price('3.33333333')
        .imported()
        .build(),
      aTransaction().transferIn().at('Clear').on('2026-03-10').quantity('3').price('3.50').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('3').price('0').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('3').price('0').build(),
    ];
    expect(pairedTransferIds(ledger).size).toBe(0);
    const snapshot = await flowsOn(ledger, '2026-03-10', [['2026-03-10', '3.40']]);
    expect(snapshot.netContributions.toString()).toBe('10.16666665');
    expect(snapshot.marketFlows.toString()).toBe('10');
  });

  it('#145 (changed by #183): a credit B3 priced itself, paired with its debit, contributes nothing', () => {
    //   buy 100 @ 10,00 at Clear          → +1.000,00
    //   debit 100 at Clear (price-less)   ┐ one-to-one pair (BR-005-20a):
    //   credit 100 at XP, B3 price 12,50  ┘ internal — zero on both figures
    //   net = market = 1.000,00
    // #181 locked in 1.250,00 here — the credit in at 12,50, the debit out at
    // the carried 10,00 — reading the +250,00 as "the lot's cost basis rose".
    // DL-013-09 overturned that: no money moved, so nothing was contributed,
    // and on a flat close of 11,00 the 250,00 read as a −22,7 % day in TWR.
    // Pairing, not price, is what makes a move internal.
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('100').price('10').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('100').price('0').build(),
      aTransaction().transferIn().at('XP').on('2026-03-10').quantity('100').price('12.50').build(),
    ];
    expect(contributionsOn(ledger, '2026-03-10').toString()).toBe('1000');
    expect(marketFlowsOn(ledger, '2026-03-10').toString()).toBe('1000');
  });

  it('a debit whose source cannot be replayed is reported, never flowed as zero', () => {
    // 11 shares leave a position holding 10: there is no cost to carry.
    const ledger = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('10').price('10').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('11').price('0').build(),
    ];
    const snapshot = buildSnapshot(d('2026-03-10'), [], ledger);
    expect(snapshot.ok ? 'ok' : snapshot.error.code).toBe('INSUFFICIENT_QUANTITY');
    const series = buildSnapshotSeries([d('2026-03-09'), d('2026-03-10')], new Map(), ledger);
    expect(series.ok ? 'ok' : series.error.code).toBe('INSUFFICIENT_QUANTITY');
    // Before the debit's date there is nothing to value, and the day stands.
    expect(contributionsOn(ledger, '2026-03-09').toString()).toBe('100');
  });

  it('TS-07: a backdated transfer gives the same figures as one that was always there', () => {
    //   03-02  buy 10 @ 3,00 + 1,00 at Clear  → +31,00, average 3,10
    //   03-05  debit 6 at Clear               → −6 × 3,10 = −18,60
    //   03-05  credit 6 at XP carrying 3,10   → +18,60
    //   03-09  buy 5 @ 4,00 at Clear          → +20,00
    //   net on 03-09 = 31,00 + 20,00 = 51,00
    const history = (backdated: boolean): readonly Transaction[] => {
      resetTransactionSequence();
      const transfer = () => [
        aTransaction().transferOut().at('Clear').on('2026-03-05').quantity('6').price('0').build(),
        aTransaction().transferIn().at('XP').on('2026-03-05').quantity('6').price('3.1').build(),
      ];
      const first = aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('10')
        .price('3')
        .fees('1')
        .build();
      if (!backdated) {
        const moved = transfer();
        const last = aTransaction()
          .buy()
          .at('Clear')
          .on('2026-03-09')
          .quantity('5')
          .price('4')
          .build();
        return [first, ...moved, last];
      }
      const last = aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-09')
        .quantity('5')
        .price('4')
        .build();
      // Recorded after the 03-09 buy, and appended last.
      return [first, last, ...transfer()];
    };
    const dates = [d('2026-03-02'), d('2026-03-05'), d('2026-03-09')];
    const always = unwrap(buildSnapshotSeries(dates, new Map(), history(false)));
    const inserted = unwrap(buildSnapshotSeries(dates, new Map(), history(true)));
    expect(inserted.map((snapshot) => snapshot.netContributions.toString())).toEqual([
      '31',
      '31',
      '51',
    ]);
    expect(always.map(serializeSnapshot)).toEqual(inserted.map(serializeSnapshot));
  });

  it('TS-11: three hundred repeating-average pairs leave not one storage unit behind', () => {
    // Day i (i = 1…300): buy 7 @ p = (10 + i),99 + 0,03 at Clear, then move all
    // 7 to XP. average = p + 0,03 ÷ 7 = (10 + i),99428571428…, so each credit
    // carries (10 + i),99428571 and each debit takes 7 × that away — equal.
    //
    //   Σ buys = 7 × Σ(10,99 + i) + 300 × 0,03
    //          = 7 × (300 × 10,99 + 300 × 301 ÷ 2) + 9,00
    //          = 7 × (3.297 + 45.150) + 9,00 = 339.129,00 + 9,00 = 339.138,00
    //
    // Were the debit valued at its unrounded cost, each pair would leave
    // 7 × 0,00428571 − 7 × 0,0042857142857… = 0,02999997 − 0,03 = −0,00000003,
    // and 300 of them would drift the total to 339.137,999991.
    const ledger: Transaction[] = [];
    const start = Date.UTC(2025, 0, 1);
    for (let i = 1; i <= 300; i += 1) {
      const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      ledger.push(
        aTransaction()
          .buy()
          .at('Clear')
          .on(date)
          .quantity('7')
          .price(`${10 + i}.99`)
          .fees('0.03')
          .build(),
        aTransaction().transferOut().at('Clear').on(date).quantity('7').price('0').build(),
        aTransaction()
          .transferIn()
          .at('XP')
          .on(date)
          .quantity('7')
          .price(`${10 + i}.99428571`)
          .build(),
      );
    }
    const last = ledger.at(-1)?.tradeDate as BusinessDate;
    expect(contributionsOn(ledger, last).equals(Money.fromString('339138'))).toBe(true);
    const series = unwrap(buildSnapshotSeries([last], new Map(), ledger));
    expect(series[0]?.netContributions.equals(Money.fromString('339138'))).toBe(true);
  });

  it('BR-007-05c: computeSnapshots hands the context’s amortization terms to the flow fold', async () => {
    //   03-16  buy 100 PETR4 @ 10,00 at Clear → +1.000,00
    //   03-17  restitution 100 × 1,00 = 100,00 → cost 900,00, average 9,00
    //          (earnings, not a flow — SPEC-014 BR-014-01)
    //   03-18  debit 100 at Clear → −100 × 9,00 = −900,00
    //          credit 100 at XP carrying 9,00 → +900,00
    //   net contributions stay 1.000,00 on every day.
    // Without the terms the debit's fold could not read the amortization and
    // the rebuild would fail rather than flow it.
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-16', '10.50');
    const ledger = [
      aTransaction()
        .buy()
        .of('PETR4')
        .at('Clear')
        .on('2026-03-16')
        .quantity('100')
        .price('10')
        .build(),
      aTransaction()
        .amortization()
        .of('PETR4')
        .at('Clear')
        .on('2026-03-17')
        .quantity('100')
        .price('1')
        .build(),
      aTransaction()
        .transferOut()
        .of('PETR4')
        .at('Clear')
        .on('2026-03-18')
        .quantity('100')
        .price('0')
        .build(),
      aTransaction()
        .transferIn()
        .of('PETR4')
        .at('XP')
        .on('2026-03-18')
        .quantity('100')
        .price('9')
        .build(),
    ];
    const result = await rebuildSnapshots(h.deps, ledger, {
      from: d('2026-03-16'),
      to: d('2026-03-18'),
    });
    const snapshots = unwrap(result);
    expect(snapshots.map((snapshot) => snapshot.netContributions.toString())).toEqual([
      '1000',
      '1000',
      '1000',
    ]);
    expect(snapshots.map((snapshot) => snapshot.earningsToDate.toString())).toEqual([
      '0',
      '100',
      '100',
    ]);
    // The flow fold without terms refuses, which is what the wiring prevents.
    const bare = buildSnapshot(d('2026-03-18'), [], ledger);
    expect(bare.ok ? 'ok' : bare.error.code).toBe('AMORTIZATION_TERMS_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------

describe('SPEC-013 BR-013-08 × SPEC-005 BR-005-20a — the credit ingestion carries equals the cost the debit takes (review F4)', () => {
  /**
   * Nothing hand-types a credit price here. Each credit's `unitPrice` comes
   * through the real import path — `resolveCarriedCosts` reading the source
   * history, `withCarriedCost` storing it at NUMERIC(20,8) — and the pair is
   * then put through `buildSnapshotSeries`. Net contributions must equal those
   * of the same ledger with the transfers taken out, on every date: a move
   * between the user's own custodians is exactly no money in or out.
   */
  interface Move {
    readonly from: string;
    readonly to: string;
    readonly on: string;
    readonly quantity: string;
  }

  function viaIngestion(
    history: readonly Transaction[],
    moves: readonly Move[],
    amortization: AmortizationTerms = new Map(),
  ): { ledger: readonly Transaction[]; prices: readonly string[] } {
    const legs: CarryLeg[] = moves.map((move, index) => ({
      id: `move-${index}`,
      // Written by import, as a carried credit is — which is what tells the
      // ledger-side pairing it was price-less (`isCarriedCredit`).
      credit: aTransaction()
        .transferIn()
        .at(move.to)
        .on(move.on)
        .quantity(move.quantity)
        .price('0')
        .imported()
        .build(),
      debit: aTransaction()
        .transferOut()
        .at(move.from)
        .on(move.on)
        .quantity(move.quantity)
        .price('0')
        .build(),
      fallback: null,
    }));
    // What a commit writes before the credits take their cost: the history
    // and the debits (`history` in resolveCarriedCosts' contract).
    const written = [...history, ...legs.map((leg) => leg.debit as Transaction)];
    const costs = resolveCarriedCosts(
      legs,
      (assetId, institutionId) =>
        written.filter((row) => row.assetId === assetId && row.institutionId === institutionId),
      amortization,
    );
    const credits = legs.map((leg) => {
      const cost = costs.get(leg.id);
      if (cost === undefined) throw new Error(`${leg.id} carried no cost`);
      return withCarriedCost(leg.credit, cost);
    });
    return {
      ledger: [...written, ...credits],
      prices: credits.map((credit) => credit.unitPrice.toString()),
    };
  }

  /**
   * Net contributions per date, asserted equal to the transfer-free ledger's —
   * and market flows likewise (#183: every pair here is internal, so neither
   * figure may see it).
   */
  function netOfMoves(
    history: readonly Transaction[],
    ledger: readonly Transaction[],
    dates: readonly string[],
    amortization: AmortizationTerms = new Map(),
  ): readonly string[] {
    const on = dates.map(d);
    const moved = unwrap(buildSnapshotSeries(on, new Map(), ledger, { amortization }));
    const unmoved = unwrap(buildSnapshotSeries(on, new Map(), history, { amortization }));
    const figures = moved.map((snapshot) => snapshot.netContributions.toString());
    expect(figures).toEqual(unmoved.map((snapshot) => snapshot.netContributions.toString()));
    expect(moved.map((snapshot) => snapshot.marketFlows.toString())).toEqual(
      unmoved.map((snapshot) => snapshot.marketFlows.toString()),
    );
    return figures;
  }

  it('a repeating average: buy 7 @ 18,99 + 0,03, all 7 to XP', () => {
    //   Clear: 132,96 ÷ 7 = 18,994285714… → credit stored at 18,99428571
    //   credit +7 × 18,99428571 = +132,95999997; debit −132,95999997
    //   net = 132,96 before and after the move
    const history = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('7')
        .price('18.99')
        .fees('0.03')
        .build(),
    ];
    const { ledger, prices } = viaIngestion(history, [
      { from: 'Clear', to: 'XP', on: '2026-03-10', quantity: '7' },
    ]);
    expect(prices).toEqual(['18.99428571']);
    expect(netOfMoves(history, ledger, ['2026-03-09', '2026-03-10'])).toEqual(['132.96', '132.96']);
  });

  it('a partial debit after a sale: buy 9 @ 10,00 + 1,00, sell 2, move 4', () => {
    //   Clear: 91,00 ÷ 9 = 10,1111…; sell 2 @ 12,00 → −24,00, average unchanged
    //   credit stored at 10,11111111; debit and credit ±4 × 10,11111111 = ±40,44444444
    //   net = 91,00 − 24,00 = 67,00
    const history = [
      aTransaction().buy().at('Clear').on('2026-03-02').quantity('9').price('10').fees('1').build(),
      aTransaction().sell().at('Clear').on('2026-03-05').quantity('2').price('12').build(),
    ];
    const { ledger, prices } = viaIngestion(history, [
      { from: 'Clear', to: 'XP', on: '2026-03-10', quantity: '4' },
    ]);
    expect(prices).toEqual(['10.11111111']);
    expect(netOfMoves(history, ledger, ['2026-03-09', '2026-03-10'])).toEqual(['67', '67']);
  });

  it('an amortizing asset: the restitution lowers the cost both sides read', () => {
    //   Clear: buy 3 @ 3,33 + 0,01 → 10,00; restitution 3 × 0,10 = 0,30 (all
    //   principal, BR-007-05c) → 9,70, average 3,2333… → credit 3,23333333
    //   debit and credit ±3 × 3,23333333 = ±9,69999999
    //   net = 10,00 (the restitution is earnings, not a flow)
    const terms = amortizationTermsOf([{ assetId: PETR4, code: 'PETR4', assetClass: 'stock' }]);
    const history = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      aTransaction()
        .amortization()
        .at('Clear')
        .on('2026-03-05')
        .quantity('3')
        .price('0.10')
        .build(),
    ];
    const { ledger, prices } = viaIngestion(
      history,
      [{ from: 'Clear', to: 'XP', on: '2026-03-10', quantity: '3' }],
      terms,
    );
    expect(prices).toEqual(['3.23333333']);
    expect(netOfMoves(history, ledger, ['2026-03-09', '2026-03-10'], terms)).toEqual(['10', '10']);
  });

  it('#135 and its #145 follow-up: same-institution round trips, one pair and two', () => {
    //   Clear: buy 3 @ 3,33 + 0,01 → 10,00, average 3,3333… → credits 3,33333333
    //   The credits apply first (rank 0); the debits then see an average
    //   between 3,3333… and 3,33333333, which rounds to 3,33333333 again.
    //   net = 10,00
    const history = () => [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
    ];
    const trip = { from: 'Clear', to: 'Clear', on: '2026-03-10', quantity: '3' };

    const singleHistory = history();
    const single = viaIngestion(singleHistory, [trip]);
    expect(single.prices).toEqual(['3.33333333']);
    expect(netOfMoves(singleHistory, single.ledger, ['2026-03-09', '2026-03-10'])).toEqual([
      '10',
      '10',
    ]);

    const doubleHistory = history();
    const double = viaIngestion(doubleHistory, [trip, trip]);
    expect(double.prices).toEqual(['3.33333333', '3.33333333']);
    expect(netOfMoves(doubleHistory, double.ledger, ['2026-03-09', '2026-03-10'])).toEqual([
      '10',
      '10',
    ]);
  });

  it('F6: a split between buy and debit — the credit carries 1,66666667 and the net stays 10,00', () => {
    //   Clear: buy 3 @ 3,33 + 0,01 → 10,00; split ×2 → 6 shares, 10,00
    //   average 1,6666… → credit stored at 1,66666667 (half-up)
    //   debit and credit ±6 × 1,66666667 = ±10,00000002
    //   net = 10,00
    const history = [
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('3')
        .price('3.33')
        .fees('0.01')
        .build(),
      aTransaction().split().at('Clear').on('2026-03-05').ratio('2').build(),
    ];
    const { ledger, prices } = viaIngestion(history, [
      { from: 'Clear', to: 'XP', on: '2026-03-10', quantity: '6' },
    ]);
    expect(prices).toEqual(['1.66666667']);
    expect(netOfMoves(history, ledger, ['2026-03-09', '2026-03-10'])).toEqual(['10', '10']);
  });

  it('a same-day chain into a broker that already held some, and on out of it', () => {
    //   XP already holds 5 @ 7,00 = 35,00. Clear holds 7 costing 132,96.
    //   03-10 Clear → XP 7: credit 18,99428571 → XP 12 shares, 167,95999997
    //   03-10 XP → Rico 4: XP average 13,996666664166… → credit 13,99666666
    //         debit and credit ±4 × 13,99666666 = ±55,98666664
    //   net = 35,00 + 132,96 = 167,96
    const history = [
      aTransaction().buy().at('XP').on('2026-03-02').quantity('5').price('7').build(),
      aTransaction()
        .buy()
        .at('Clear')
        .on('2026-03-02')
        .quantity('7')
        .price('18.99')
        .fees('0.03')
        .build(),
    ];
    const { ledger, prices } = viaIngestion(history, [
      { from: 'Clear', to: 'XP', on: '2026-03-10', quantity: '7' },
      { from: 'XP', to: 'Rico', on: '2026-03-10', quantity: '4' },
    ]);
    expect(prices).toEqual(['18.99428571', '13.99666666']);
    expect(netOfMoves(history, ledger, ['2026-03-09', '2026-03-10'])).toEqual(['167.96', '167.96']);
  });
});

// ---------------------------------------------------------------------------

describe('#183 — SPEC-013 BR-013-08 (DL-013-09) / SPEC-012 BR-012-01 (DL-012-08): the two flow figures', () => {
  interface Figures {
    readonly net: readonly string[];
    readonly market: readonly string[];
    readonly estimated: readonly boolean[];
  }

  /**
   * Both figures on each date, from the accumulating series — asserted equal,
   * snapshot for snapshot, to the from-scratch build (DM-4), so every fixture
   * below is also a small rebuild-equals-incremental check.
   */
  async function figuresOn(
    ledger: readonly Transaction[],
    dates: readonly string[],
    seed: (h: Harness) => void,
  ): Promise<Figures> {
    const h = harness();
    seed(h);
    const on = dates.map(d);
    const context = await loadValuationContext(
      h.deps,
      ledger,
      d('2026-03-01'),
      on.at(-1) as BusinessDate,
    );
    const series = unwrap(buildSnapshotSeries(on, new Map(), ledger, { context }));
    for (const snapshot of series) {
      const scratch = unwrap(buildSnapshot(snapshot.date, [], ledger, { context }));
      expect(snapshotsEqual(snapshot, scratch), snapshot.date).toBe(true);
    }
    return {
      net: series.map((snapshot) => snapshot.netContributions.toString()),
      market: series.map((snapshot) => snapshot.marketFlows.toString()),
      estimated: series.map((snapshot) => snapshot.hasEstimates),
    };
  }

  const bought = (quantity = '100', price = '10') =>
    aTransaction().buy().at('Clear').on('2026-03-02').quantity(quantity).price(price).build();

  it('#145 shape — a priced credit paired with a carried-cost debit contributes zero to both', async () => {
    //   buy 100 @ 10,00 at Clear         → +1.000,00 on both figures
    //   10/03 debit 100 at Clear, credit 100 at XP at B3's 12,50, close 11,00
    //     #181 (per leg): +1.250,00 − 1.000,00 = +250,00 — a deposit nobody made
    //     #183 (paired):  0 on both
    const ledger = [
      bought(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('100').price('0').build(),
      aTransaction().transferIn().at('XP').on('2026-03-10').quantity('100').price('12.50').build(),
    ];
    const figures = await figuresOn(ledger, ['2026-03-09', '2026-03-10'], (h) => {
      h.prices.addClose(PETR4, '2026-03-09', '11');
      h.prices.addClose(PETR4, '2026-03-10', '11');
    });
    expect(figures.net).toEqual(['1000', '1000']);
    expect(figures.market).toEqual(['1000', '1000']);
  });

  it('#112 shape — a credit on a stored fallback cost, paired with a zero-cost debit, contributes zero', async () => {
    //   02/03 bonificação of 10 at Clear, zero attributed value → 10 shares, cost 0
    //   10/03 debit 10 at Clear (carries round₈(0) = 0), credit 10 at XP kept at
    //         the 5,00 an earlier import carried (#112 fallback)
    //     #181 (per leg): +10 × 5,00 − 10 × 0 = +50,00
    //     #183 (paired):  0 on both — no money in or out on any day
    const ledger = [
      aTransaction().bonificacao().at('Clear').on('2026-03-02').quantity('10').build(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('10').price('0').build(),
      aTransaction()
        .transferIn()
        .at('XP')
        .on('2026-03-10')
        .quantity('10')
        .price('5')
        .imported()
        .build(),
    ];
    // The fixture really is the #112 shape: the debit carries nothing out.
    const carried = unwrap(costsCarriedOut(ledger));
    expect([...carried.values()].map((cost) => cost.toString())).toEqual(['0']);
    const figures = await figuresOn(ledger, ['2026-03-09', '2026-03-10'], (h) => {
      h.prices.addClose(PETR4, '2026-03-10', '6');
    });
    expect(figures.net).toEqual(['0', '0']);
    expect(figures.market).toEqual(['0', '0']);
  });

  it('an unpaired transfer out: −1.000 at cost, −4.000 at market', async () => {
    //   buy 100 @ 10,00 at Clear → +1.000,00 on both
    //   10/03 all 100 leave for custody the ledger does not track, close 40,00
    //     net    1.000,00 − 100 × 10,00 = 0      (a step of −1.000,00)
    //     market 1.000,00 − 100 × 40,00 = −3.000 (a step of −4.000,00)
    const ledger = [
      bought(),
      aTransaction().transferOut().at('Clear').on('2026-03-10').quantity('100').price('0').build(),
    ];
    const figures = await figuresOn(ledger, ['2026-03-09', '2026-03-10'], (h) => {
      h.prices.addClose(PETR4, '2026-03-09', '40');
      h.prices.addClose(PETR4, '2026-03-10', '40');
    });
    expect(figures.net).toEqual(['1000', '0']);
    expect(figures.market).toEqual(['1000', '-3000']);
    expect(figures.estimated).toEqual([false, false]);
  });

  it('an unpaired transfer in: +800 at cost, +1.100 at market', async () => {
    //   buy 100 @ 10,00 at Clear → +1.000,00 on both
    //   10/03 100 arrive at XP carried at 8,00, close 11,00
    //     net    1.000,00 + 100 × 8,00  = 1.800,00 (a step of +800,00)
    //     market 1.000,00 + 100 × 11,00 = 2.100,00 (a step of +1.100,00)
    const ledger = [
      bought(),
      aTransaction().transferIn().at('XP').on('2026-03-10').quantity('100').price('8').build(),
    ];
    const figures = await figuresOn(ledger, ['2026-03-09', '2026-03-10'], (h) => {
      h.prices.addClose(PETR4, '2026-03-09', '10');
      h.prices.addClose(PETR4, '2026-03-10', '11');
    });
    expect(figures.net).toEqual(['1000', '1800']);
    expect(figures.market).toEqual(['1000', '2100']);
  });

  it('no close on the transfer date: the last close before it, carried forward, and no estimate', async () => {
    //   buy 100 @ 10,00 → +1.000,00; Saturday 14/03 30 leave, unpaired.
    //   The last close on or before 14/03 is Friday 13/03's 12,50 (BR-009-03):
    //     market 1.000,00 − 30 × 12,50 = 625,00
    //     net    1.000,00 − 30 × 10,00 = 700,00
    // An older observed close is still an observed price, not an estimate.
    const ledger = [
      bought(),
      aTransaction().transferOut().at('Clear').on('2026-03-14').quantity('30').price('0').build(),
    ];
    const figures = await figuresOn(ledger, ['2026-03-13', '2026-03-14', '2026-03-15'], (h) => {
      h.prices.addClose(PETR4, '2026-03-13', '12.50');
      h.prices.addClose(PETR4, '2026-03-16', '13');
    });
    expect(figures.market).toEqual(['1000', '625', '625']);
    expect(figures.net).toEqual(['1000', '700', '700']);
    expect(figures.estimated).toEqual([false, false, false]);
  });

  it('no close ever: valued at the leg’s own cost, never zero, and that date marked an estimate', async () => {
    //   VALE3 has no close at all — the engine values such a holding at cost
    //   and flags it (COST_FALLBACK); the flow is valued the same way.
    //   10/03 in  10 @ 50,33333333      → +10 × 50,33333333 = +503,3333333 both
    //   11/03 out 4; average 503,3333333 ÷ 10 = 50,33333333, exact at 8 places
    //         → −4 × 50,33333333 = −201,33333332 both
    //         → 503,3333333 − 201,33333332 = 301,99999998
    //   12/03 nothing moves, and nothing is marked.
    // Both figures agree here (the only fallback is cost), but neither is ever
    // zero — and the two transfer dates say their flow is an estimate.
    const ledger = [
      aTransaction()
        .transferIn()
        .of('VALE3')
        .at('XP')
        .on('2026-03-10')
        .quantity('10')
        .price('50.33333333')
        .build(),
      aTransaction()
        .transferOut()
        .of('VALE3')
        .at('XP')
        .on('2026-03-11')
        .quantity('4')
        .price('0')
        .build(),
    ];
    const figures = await figuresOn(ledger, ['2026-03-10', '2026-03-11', '2026-03-12'], () => {});
    // The fixture is what it claims: the debit carries 4 × 50,33333333.
    expect([...unwrap(costsCarriedOut(ledger)).values()].map(String)).toEqual(['201.33333332']);
    expect(figures.net).toEqual(['503.3333333', '301.99999998', '301.99999998']);
    expect(figures.market).toEqual(['503.3333333', '301.99999998', '301.99999998']);
    expect(figures.estimated).toEqual([true, true, false]);
  });

  it('bank paper arriving from outside flows at its accrued value; Tesouro at its sell price', async () => {
    //   20/03 1 CDB (110 % CDI, issued 16/03) arrives carried at 10.000,00:
    //     net    +10.000,00
    //     market +10.000 × 1,002197970588… = +10.021,97970588… (the value the
    //            three-method fixture above derives — accrued, so an estimate)
    //   20/03 3,5 Tesouro IPCA+ arrive carried at 3.200,00, sell price 3.413,70:
    //     net    +3,5 × 3.200,00 = +11.200,00
    //     market +3,5 × 3.413,70 = +11.947,95
    const ledger = [
      aTransaction()
        .transferIn()
        .of('CDB BANCO X 2028')
        .at('XP')
        .on('2026-03-20')
        .quantity('1')
        .price('10000')
        .build(),
      aTransaction()
        .transferIn()
        .of('Tesouro IPCA+ 2035')
        .at('XP')
        .on('2026-03-20')
        .quantity('3.5')
        .price('3200')
        .build(),
    ];
    const h = harness();
    h.prices.addClose(TESOURO, '2026-03-20', '3413.70');
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));
    const context = await loadValuationContext(h.deps, ledger, d('2026-03-16'), d('2026-03-20'));
    const snapshot = unwrap(buildSnapshot(d('2026-03-20'), [], ledger, { context }));
    expect(snapshot.netContributions.toString()).toBe('21200');
    // 10.021,97970588 + 11.947,95 = 21.969,92970588 at NUMERIC(20,8)
    expect(to8(snapshot.marketFlows)).toBe('21969.92970588');
    expect(snapshot.hasEstimates).toBe(true);
  });

  it('an unpaired transfer with no valuation context throws — zero is never the answer', () => {
    const ledger = [
      aTransaction().transferIn().at('XP').on('2026-03-10').quantity('100').price('8').build(),
    ];
    expect(() => buildSnapshot(d('2026-03-10'), [], ledger)).toThrow(/SPEC-013 BR-013-08/);
    expect(() => buildSnapshotSeries([d('2026-03-10')], new Map(), ledger)).toThrow(
      /SPEC-013 BR-013-08/,
    );
  });

  it('an unpaired transfer of an asset the catalog does not know is an error on both builders', async () => {
    const ledger = [
      aTransaction()
        .transferIn()
        .of('XPTO3')
        .at('XP')
        .on('2026-03-10')
        .quantity('1')
        .price('8')
        .build(),
    ];
    const context = await loadValuationContext(
      harness().deps,
      ledger,
      d('2026-03-10'),
      d('2026-03-10'),
    );
    const scratch = buildSnapshot(d('2026-03-10'), [], ledger, { context });
    expect(scratch.ok ? 'ok' : scratch.error.code).toBe(ValuationErrorCode.ASSET_NOT_FOUND);
    const series = buildSnapshotSeries([d('2026-03-10')], new Map(), ledger, { context });
    expect(series.ok ? 'ok' : series.error.code).toBe(ValuationErrorCode.ASSET_NOT_FOUND);
  });

  describe('withTransferCloses — a rebuild that starts after an unpaired transfer still values it', () => {
    /**
     *   02/03 buy 100 PETR4 @ 10,00 at Clear                 +1.000,00 both
     *   03/03 10 VALE3 arrive at XP @ 50,00, no close ever   +500,00 both (cost fallback)
     *   04/03 10 leave Clear, unpaired, last close 03/03 9,50  net −100,00, market −95,00
     *   04/03 5 more leave Clear, unpaired, same close          net −50,00,  market −47,50
     *   04/03 a credit of 10 at XP, *unclassified* — out of the arithmetic,
     *         so it pairs with nothing and the debit of 10 stays unpaired
     *   05/03 20 move Clear → XP, paired                        0 both
     *   18/03 1 arrives at Rico carried at 13,00, close 14,00   net +13,00, market +14,00
     *
     *   18/03 net    1.000 + 500 − 100 − 50 + 13     = 1.363,00
     *         market 1.000 + 500 − 95 − 47,50 + 14   = 1.371,50
     *
     * A rebuild of [17/03, 18/03] alone loads closes from 17/03's anchor on;
     * without `withTransferCloses` the 04/03 debits would find no close, fall
     * back to cost and read −150,00 rather than −142,50.
     */
    function ledger(): readonly Transaction[] {
      return [
        bought(),
        aTransaction()
          .transferIn()
          .of('VALE3')
          .at('XP')
          .on('2026-03-03')
          .quantity('10')
          .price('50')
          .build(),
        aTransaction().transferOut().at('Clear').on('2026-03-04').quantity('10').price('0').build(),
        aTransaction().transferOut().at('Clear').on('2026-03-04').quantity('5').price('0').build(),
        aTransaction()
          .transferIn()
          .at('XP')
          .on('2026-03-04')
          .quantity('10')
          .price('10')
          .status('unclassified')
          .build(),
        aTransaction().transferOut().at('Clear').on('2026-03-05').quantity('20').price('0').build(),
        aTransaction().transferIn().at('XP').on('2026-03-05').quantity('20').price('10').build(),
        aTransaction().transferIn().at('Rico').on('2026-03-18').quantity('1').price('13').build(),
      ];
    }

    function seeded(): Harness {
      const h = harness();
      h.prices.addClose(PETR4, '2026-03-03', '9.50');
      h.prices.addClose(PETR4, '2026-03-10', '12');
      h.prices.addClose(PETR4, '2026-03-17', '13');
      h.prices.addClose(PETR4, '2026-03-18', '14');
      h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));
      return h;
    }

    it('a short rebuild equals the full one on every date they share (DM-4)', async () => {
      const h = seeded();
      const full = unwrap(
        await computeSnapshots(h.deps, ledger(), { from: d('2026-03-02'), to: d('2026-03-18') }),
      );
      const short = unwrap(
        await computeSnapshots(h.deps, ledger(), { from: d('2026-03-17'), to: d('2026-03-18') }),
      );
      expect(short.map((snapshot) => snapshot.date)).toEqual(['2026-03-17', '2026-03-18']);
      for (const snapshot of short) {
        const reference = full.find((candidate) => candidate.date === snapshot.date);
        if (reference === undefined) throw new Error(`no full snapshot on ${snapshot.date}`);
        expect(snapshotsEqual(snapshot, reference), snapshot.date).toBe(true);
      }
      expect(short.at(-1)?.netContributions.toString()).toBe('1363');
      expect(short.at(-1)?.marketFlows.toString()).toBe('1371.5');
    });

    it('asks for one close per unpaired transfer before the range, and inserts it in date order', async () => {
      const h = seeded();
      const from = d('2026-03-17');
      const rows = [
        ...ledger(),
        // Bank paper has no closes to add to — it accrues from its contract.
        aTransaction()
          .transferIn()
          .of('CDB BANCO X 2028')
          .at('XP')
          .on('2026-03-16')
          .quantity('1')
          .price('1000')
          .build(),
      ];
      const context = await loadValuationContext(h.deps, rows, from, d('2026-03-18'));
      const asked: string[] = [];
      const spy = {
        getCloseOnOrBefore: async (assetId: AssetId, date: BusinessDate) => {
          asked.push(`${assetId === PETR4 ? 'PETR4' : 'VALE3'}@${date}`);
          return h.prices.getCloseOnOrBefore(assetId, date);
        },
      };
      const widened = await withTransferCloses(spy, context, rows, from);

      // The two 04/03 debits ask (the second finds its close already there);
      // VALE3 asks and finds none. Not the buy, the unclassified credit, the
      // 05/03 pair, the 18/03 arrival inside the range, or the CDB.
      expect(asked).toEqual(['VALE3@2026-03-03', 'PETR4@2026-03-04', 'PETR4@2026-03-04']);
      expect(widened.closes.get(PETR4)?.map((quote) => quote.date)).toEqual([
        '2026-03-03',
        '2026-03-17',
        '2026-03-18',
      ]);
      expect(widened.closes.get(VALE3)).toEqual([]);
      expect(widened.closes.has(CDB)).toBe(false);
      // Everything else about the context is untouched.
      expect(widened.contracts).toBe(context.contracts);
    });
  });
});
