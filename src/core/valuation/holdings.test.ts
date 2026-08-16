import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { assetIdFor } from '@/core/ledger/test-support/transaction-builder';
import { FakeAssetCatalog } from '@/core/quotes/test-support';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { loadValuationContextForAssets, type SnapshotDependencies } from './snapshot';
import { valueHoldingsAt, type Holding } from './holdings';
import { ValuationErrorCode } from './ports';
import {
  FakeFixedIncomeContracts,
  FakeIndexSeriesReader,
  FakePriceHistory,
  FakeSnapshotRepository,
  aContract,
  indexPoint,
} from './test-support';

/**
 * SPEC-009 — `valueHoldingsAt`, the arithmetic a snapshot and a report share.
 *
 * `snapshot.test.ts` already covers what this produces when the holdings come
 * from a ledger replay. What is tested here is the property the *report* newly
 * depends on and the snapshot never did: **the same asset may appear more than
 * once**, split across institutions, and the parts must sum to what the whole
 * would have been.
 *
 * TS-04: every expected figure below is hand-computed and shown.
 */

const calendar = new B3TradingCalendar();
const d = (value: string): BusinessDate => BusinessDate.of(value);
const to8 = (value: Money): string => value.toDecimal().toFixed(8);

const PETR4 = assetIdFor('PETR4');
const TESOURO = assetIdFor('Tesouro IPCA+ 2035');
const CDB = assetIdFor('CDB BANCO X 2028');

/** The same CDI fixture `snapshot.test.ts` and `accrual.test.ts` derive from. */
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
  readonly deps: Omit<SnapshotDependencies, 'snapshots'>;
  readonly prices: FakePriceHistory;
  readonly contracts: FakeFixedIncomeContracts;
}

function harness(): Harness {
  const prices = new FakePriceHistory();
  const contracts = new FakeFixedIncomeContracts();
  const series = new FakeIndexSeriesReader().set('CDI', CDI).set('IPCA', []);
  void new FakeSnapshotRepository();
  return {
    prices,
    contracts,
    deps: { calendar, prices, contracts, indexSeries: series, assets: catalog() },
  };
}

const holding = (assetId: Holding['assetId'], quantity: string, averageCost: string): Holding => ({
  assetId,
  quantity: Quantity.fromString(quantity),
  averageCost: Money.fromString(averageCost),
});

function sum(values: readonly Money[]): Money {
  return values.reduce((total, value) => total.plus(value), Money.zero());
}

describe('valueHoldingsAt — splitting a holding across institutions', () => {
  /**
   * The property the report rests on. It groups by institution, so it passes
   * one holding per (asset, institution) pair rather than aggregating first
   * the way a snapshot does. If the parts did not sum to the whole, SPEC-015's
   * per-institution breakdown would disagree with SPEC-013's headline total
   * and TS-12's cross-report invariant would be unsatisfiable.
   */
  it('a listed position split across two brokers sums to the unsplit value', async () => {
    // 100 PETR4 @ close 38,42 = 3.842,00 — whether that is one row of 100 or
    // 60 + 40, because value is quantity × price and price is per unit.
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-20', '38.42');
    const context = await loadValuationContextForAssets(
      h.deps,
      [PETR4],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const whole = valueHoldingsAt(
      context,
      [holding(PETR4, '100', '32.15')],
      d('2026-03-20'),
      'historical',
    );
    const split = valueHoldingsAt(
      context,
      [holding(PETR4, '60', '32.15'), holding(PETR4, '40', '32.15')],
      d('2026-03-20'),
      'historical',
    );

    expect(whole.ok && split.ok).toBe(true);
    if (!whole.ok || !split.ok) return;

    expect(to8(sum(whole.value.map((p) => p.value)))).toBe('3842.00000000');
    expect(to8(sum(split.value.map((p) => p.value)))).toBe('3842.00000000');
    expect(split.value).toHaveLength(2);
  });

  /**
   * The one that could genuinely have gone wrong. Accrual applies a factor to
   * the holding's **own** cost basis, so two rows with different average costs
   * accrue independently — and that is more correct than pro-rating a single
   * aggregate value back across brokers, which is what a naive split would do.
   *
   * 110 % of CDI over the four business days 17–20 March gives the factor
   * `snapshot.test.ts` derives, 1,002197970588…:
   *
   *   whole: 10.000 × 1,00219797058842 = 10.021,97970588
   *   split:  6.000 × 1,00219797058842 =  6.013,18782353
   *           4.000 × 1,00219797058842 =  4.008,79188235
   *                                     = 10.021,97970588
   */
  it('an accrued CDB split across two brokers sums to the unsplit value', async () => {
    const h = harness();
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));
    const context = await loadValuationContextForAssets(
      h.deps,
      [CDB],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const whole = valueHoldingsAt(
      context,
      [holding(CDB, '1', '10000')],
      d('2026-03-20'),
      'historical',
    );
    const split = valueHoldingsAt(
      context,
      [holding(CDB, '0.6', '10000'), holding(CDB, '0.4', '10000')],
      d('2026-03-20'),
      'historical',
    );

    expect(whole.ok && split.ok).toBe(true);
    if (!whole.ok || !split.ok) return;

    expect(to8(sum(whole.value.map((p) => p.value)))).toBe('10021.97970588');
    expect(to8(sum(split.value.map((p) => p.value)))).toBe('10021.97970588');
  });

  it('carries the estimate flag per holding, not per portfolio', async () => {
    // BR-009-11: a listed position priced from an observed close is not an
    // estimate; an accrued CDB is. Before the report used this function it
    // marked every row estimated, which drained the badge of meaning.
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-20', '38.42');
    h.contracts.set(aContract(CDB, { issueDate: '2026-03-16' }));
    const context = await loadValuationContextForAssets(
      h.deps,
      [PETR4, CDB],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const valued = valueHoldingsAt(
      context,
      [holding(PETR4, '100', '32.15'), holding(CDB, '1', '10000')],
      d('2026-03-20'),
      'historical',
    );

    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    expect(valued.value.map((p) => p.estimated)).toEqual([false, true]);
  });

  it('drops a zero-quantity holding rather than valuing it', async () => {
    const h = harness();
    h.prices.addClose(PETR4, '2026-03-20', '38.42');
    const context = await loadValuationContextForAssets(
      h.deps,
      [PETR4],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const valued = valueHoldingsAt(
      context,
      [holding(PETR4, '0', '32.15'), holding(PETR4, '10', '32.15')],
      d('2026-03-20'),
      'historical',
    );

    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    expect(valued.value).toHaveLength(1);
    expect(to8(valued.value[0]!.value)).toBe('384.20000000');
  });

  it('fails rather than guessing when the catalog does not know an asset', async () => {
    // A foreign key makes this unreachable in production, which is exactly why
    // it is an error: there is no honest class to value an unknown asset as.
    const unknown = assetIdFor('NOT-IN-CATALOG');
    const h = harness();
    const context = await loadValuationContextForAssets(
      h.deps,
      [],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const valued = valueHoldingsAt(
      context,
      [holding(unknown, '1', '10')],
      d('2026-03-20'),
      'historical',
    );

    expect(valued.ok).toBe(false);
    if (valued.ok) return;
    expect(valued.error.code).toBe(ValuationErrorCode.ASSET_NOT_FOUND);
  });

  /**
   * BR-009-05/06, DL-009-04 — Tesouro is marked to market at the published
   * **sell** price, and it splits additively for the same reason a listed
   * position does: 3,5 × 3.413,70 = 11.947,95, whether as one row or two.
   */
  it('a Tesouro title splits additively at the sell price', async () => {
    const h = harness();
    h.prices.addClose(TESOURO, '2026-03-20', '3413.70');
    const context = await loadValuationContextForAssets(
      h.deps,
      [TESOURO],
      d('2026-03-20'),
      d('2026-03-20'),
    );

    const split = valueHoldingsAt(
      context,
      [holding(TESOURO, '2', '3200'), holding(TESOURO, '1.5', '3200')],
      d('2026-03-20'),
      'historical',
    );

    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(to8(sum(split.value.map((p) => p.value)))).toBe('11947.95000000');
  });
});
