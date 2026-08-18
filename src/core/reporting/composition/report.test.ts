import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import { Money } from '@/core/shared/money';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import {
  GROUPINGS,
  NOT_CLASSIFIED_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  type DailyValuationSnapshot,
  type Grouping,
  type Scope,
} from '@/core/reporting/ports';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import { HistoryUnavailable } from '@/core/reporting/snapshot-derived';
import {
  anAsset,
  aPosition,
  assetIdOf,
  day,
  FakeReportDataPort,
  institutionIdOf,
  money,
  qty,
  walletIdOf,
  type FakeReportData,
} from '@/core/reporting/test-support';
import { buildCompositionReport } from '@/core/reporting/composition/report';

/**
 * SPEC-015 — the Composition report end to end, over the real
 * `runReportQuery`.
 *
 * TS-01/TS-02: no database. The port is the hand-written fake implementing the
 * real interface, so the assembly is exercised against the same holding set
 * SPEC-011 hands the other three reports.
 */

const TODAY = day('2026-08-14');

const itsa = assetIdOf('1');
const hglg = assetIdOf('2');
const cdb = assetIdOf('3');
const walletA = walletIdOf('1');
const walletB = walletIdOf('2');

const snapshot = (
  date: string,
  byClass: readonly (readonly [AssetClass, string])[],
): DailyValuationSnapshot => {
  const entries = byClass.map(([assetClass, value]) => [assetClass, money(value)] as const);
  return {
    date: day(date),
    totalValue: entries.reduce((acc, [, value]) => acc.plus(value), Money.zero()),
    netContributions: money('0'),
    earningsToDate: money('0'),
    byAssetClass: new Map(entries),
    hasEstimates: false,
  };
};

/**
 * A portfolio built so every rule in SPEC-015 has something to act on:
 *
 *  - ITSA4 is held at **two institutions** and **partly allocated** to one
 *    wallet, so the row fold and BR-015-11's allocated quantities both matter.
 *  - HGLG11 has a sector; the CDB has none, so BR-015-03's "Not classified"
 *    bucket is populated rather than empty.
 *  - The CDB is `estimated`, so BR-015-09's marker has a row to sit on.
 *
 * Hand-computed — the scope totals **R$ 2.500**:
 *
 *   ITSA4  XP    60 un   →   600  ┐
 *   ITSA4  Rico  40 un   →   400  ┘ 1.000  → 40 %
 *   HGLG11        5 un   → 1.000          → 40 %
 *   CDB           1 un   →   500 (accrued) → 20 %
 *
 * The wallet holds 50 of the 100 ITSA4, so at wallet scope it is worth 500 —
 * exactly half, which is what makes BR-015-11's failure obvious if the full
 * position ever leaks through.
 */
function fixture(): FakeReportData {
  return {
    positions: [
      aPosition({
        assetId: itsa,
        institutionId: institutionIdOf('1'),
        quantity: qty('60'),
        value: money('600'),
        costBasis: money('420'),
      }),
      aPosition({
        assetId: itsa,
        institutionId: institutionIdOf('2'),
        quantity: qty('40'),
        value: money('400'),
        costBasis: money('380'),
      }),
      aPosition({
        assetId: hglg,
        institutionId: institutionIdOf('1'),
        quantity: qty('5'),
        value: money('1000'),
        costBasis: money('900'),
      }),
      aPosition({
        assetId: cdb,
        institutionId: null,
        quantity: qty('1'),
        value: money('500'),
        costBasis: money('450'),
        estimated: true,
      }),
    ],
    allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('50') }],
    wallets: [
      { walletId: walletA, name: 'Aposentadoria' },
      { walletId: walletB, name: 'Reserva' },
    ],
    institutions: [
      { institutionId: institutionIdOf('1'), name: 'XP' },
      { institutionId: institutionIdOf('2'), name: 'Rico' },
    ],
    assets: [
      anAsset({
        assetId: itsa,
        code: 'ITSA4',
        name: 'Itaúsa PN',
        assetClass: 'stock',
        sector: 'Bancos',
      }),
      anAsset({
        assetId: hglg,
        code: 'HGLG11',
        name: 'CSHG Logística',
        assetClass: 'fii',
        sector: 'Logística',
      }),
      // BR-015-03 / DL-015-04: fixed income has no sector, and it is a large
      // share of a Brazilian portfolio.
      anAsset({
        assetId: cdb,
        code: 'CDB-X',
        name: 'CDB Banco X',
        assetClass: 'cdb',
        sector: null,
      }),
    ],
    snapshots: [
      // The baseline allocation, deliberately different from today's, so
      // BR-015-04 has a real shift to report rather than three zeros.
      snapshot('2026-01-05', [
        ['stock', '200'],
        ['fii', '600'],
        ['cdb', '200'],
      ]),
      snapshot('2026-08-14', [
        ['stock', '1000'],
        ['fii', '1000'],
        ['cdb', '500'],
      ]),
    ],
  };
}

async function query(grouping: Grouping, scope: Scope): Promise<ReportQueryResult> {
  const port = new FakeReportDataPort(fixture());
  const result = await runReportQuery(
    port,
    { period: { kind: 'ytd' }, scope, grouping, today: TODAY },
    day('2026-01-01'),
  );
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

async function build(grouping: Grouping, scope: Scope = { kind: 'portfolio' }) {
  const port = new FakeReportDataPort(fixture());
  const result = await query(grouping, scope);
  return buildCompositionReport({
    query: result,
    opening: await port.findSnapshotBefore(result.range.from),
    thresholdPct: 20,
    quotedAt: new Date('2026-08-14T17:30:00Z'),
    delayMinutes: 30,
  });
}

const sum = (values: readonly Money[]): Money =>
  values.reduce((acc, value) => acc.plus(value), Money.zero());

describe('SPEC-015 AC — composition renders for all five grouping dimensions', () => {
  it.each(GROUPINGS)('%s produces slices that sum to the scope total', async (grouping) => {
    const report = await build(grouping);

    expect(report.breakdown.length).toBeGreaterThan(0);
    expect(
      sum(report.breakdown.map((slice) => slice.totals.value)).equals(report.total.value),
    ).toBe(true);
  });

  it.each(GROUPINGS)('%s: shares sum to exactly 100 %%', async (grouping) => {
    /**
     * BR-015-10, asserted as **exact** equality. An approximate comparison
     * would pass over the rounding drift the residual in `sharesOf` exists to
     * prevent — which is the only way this can realistically break.
     */
    const report = await build(grouping);
    const shares = report.breakdown.map((slice) => slice.share as Money);

    expect(shares.every((share) => share !== null)).toBe(true);
    expect(sum(shares).toString()).toBe('1');
  });

  it.each(GROUPINGS)('%s: the total never moves when the grouping does', async (grouping) => {
    // BR-011-08 carried into this report: the table below the chart is folded
    // per asset and must agree with slices folded per dimension.
    const report = await build(grouping);

    expect(report.total.value.toString()).toBe('2500');
    expect(sum(report.rows.map((row) => row.value)).equals(report.total.value)).toBe(true);
    expect(sum(report.rows.map((row) => row.share as Money)).toString()).toBe('1');
  });
});

describe('SPEC-015 AC — the table', () => {
  it('BR-015-02/08: value, quantity, both prices and the gain are correct per row', async () => {
    /**
     * ITSA4, folded across XP and Rico — hand-computed:
     *
     *   quantity       = 60 + 40    = 100
     *   value          = 600 + 400  = 1.000
     *   costBasis      = 420 + 380  =   800
     *   averagePrice   = 800 ÷ 100  =     8
     *   currentPrice   = 1.000 ÷ 100=    10
     *   unrealizedGain = 1.000 − 800=   200
     *   share          = 1.000 ÷ 2.500 =   0,4
     */
    const report = await build('asset_class');
    const row = report.rows.find((candidate) => candidate.assetCode === 'ITSA4');

    expect(row?.quantity.toString()).toBe('100');
    expect(row?.value.toString()).toBe('1000');
    expect(row?.costBasis.toString()).toBe('800');
    expect(row?.averagePrice?.toString()).toBe('8');
    expect(row?.currentPrice?.toString()).toBe('10');
    expect(row?.unrealizedGain.toString()).toBe('200');
    expect(row?.share?.toString()).toBe('0.4');
  });

  it('lists the largest holding first', async () => {
    const report = await build('asset_class');
    expect(report.rows.map((row) => row.assetCode)).toEqual(['HGLG11', 'ITSA4', 'CDB-X']);
  });

  it('BR-015-09: the accrued row is marked and the observed ones are not', async () => {
    const report = await build('asset_class');

    expect(report.rows.find((row) => row.assetCode === 'CDB-X')?.estimated).toBe(true);
    expect(report.rows.find((row) => row.assetCode === 'ITSA4')?.estimated).toBe(false);
  });
});

describe('SPEC-015 AC — BR-015-03: holdings without sector data', () => {
  it('appear under "Not classified" and the totals still reconcile', async () => {
    /**
     * DL-015-04. Dropping the CDB from the sector view would make it disagree
     * with every other view of the same scope by R$ 500, with nothing on
     * screen to explain the difference.
     */
    const bySector = await build('sector');
    const byClass = await build('asset_class');

    const notClassified = bySector.breakdown.find((slice) => slice.key.synthetic);
    expect(notClassified?.key.id).toBe(NOT_CLASSIFIED_GROUP_ID);
    expect(notClassified?.totals.value.toString()).toBe('500');
    expect(bySector.total.value.equals(byClass.total.value)).toBe(true);
  });
});

describe('SPEC-015 AC — BR-015-11/12: scope and the wallet dimension', () => {
  it('at wallet scope a partially-allocated asset shows the allocated quantity', async () => {
    /**
     * DL-015-05. The wallet holds 50 of the 100 ITSA4. Showing the full
     * position would make wallet composition wrong for every split holding and
     * would double-count across wallets — a 60/40 split appearing as 100 % in
     * both.
     */
    const report = await build('asset', { kind: 'wallet', walletId: walletA });
    const row = report.rows.find((candidate) => candidate.assetCode === 'ITSA4');

    expect(row?.quantity.toString()).toBe('50');
    expect(row?.value.toString()).toBe('500');
    expect(report.total.value.toString()).toBe('500');
    // It is the whole of this wallet, so its share is 100 %.
    expect(row?.share?.toString()).toBe('1');
  });

  it('grouping by wallet at portfolio scope includes Unassigned and sums to the portfolio', async () => {
    const report = await build('wallet');

    const unassigned = report.breakdown.find((slice) => slice.key.id === UNASSIGNED_GROUP_ID);
    expect(unassigned).toBeDefined();
    // 2.500 total − 500 filed into Aposentadoria.
    expect(unassigned?.totals.value.toString()).toBe('2000');
    expect(sum(report.breakdown.map((slice) => slice.totals.value)).toString()).toBe('2500');
    expect(sum(report.breakdown.map((slice) => slice.share as Money)).toString()).toBe('1');
  });
});

describe('SPEC-015 AC — BR-015-10 / DL-015-06: the cross-report equality', () => {
  it('the value total equals the Portfolio Value headline for the same scope and date', async () => {
    /**
     * **The most trust-destroying defect available** is two reports disagreeing
     * about how much money the user has, so it is asserted rather than
     * reasoned about (DL-015-06, consistent with SPEC-013 DL-013-06).
     *
     * It holds structurally: both fold `query.report.total`, which `aggregate`
     * summed from the holdings rather than from its own subtotals. Neither
     * report is permitted to compute the figure, so neither can disagree.
     */
    const port = new FakeReportDataPort(fixture());
    const result = await query('asset_class', { kind: 'portfolio' });
    const opening = await port.findSnapshotBefore(result.range.from);

    const composition = buildCompositionReport({
      query: result,
      opening,
      thresholdPct: 20,
      quotedAt: null,
      delayMinutes: 30,
    });
    const patrimonio = buildPortfolioValueReport({
      query: result,
      opening,
      grouping: 'asset_class',
      today: TODAY,
      lastImportAt: null,
    });

    expect(composition.total.value.equals(patrimonio.headline.currentValue)).toBe(true);
    expect(composition.total.value.toString()).toBe('2500');
  });

  it('and it still holds at wallet scope, where both reports narrow the same way', async () => {
    const scope: Scope = { kind: 'wallet', walletId: walletA };
    const result = await query('asset', scope);

    const composition = buildCompositionReport({
      query: result,
      opening: null,
      thresholdPct: 20,
      quotedAt: null,
      delayMinutes: 30,
    });
    const patrimonio = buildPortfolioValueReport({
      query: result,
      opening: null,
      grouping: 'asset',
      today: TODAY,
      lastImportAt: null,
    });

    expect(composition.total.value.equals(patrimonio.headline.currentValue)).toBe(true);
    expect(composition.total.value.toString()).toBe('500');
  });
});

describe('SPEC-015 AC — BR-015-05: the concentration flag', () => {
  it('flags the holdings above the configured threshold and names the threshold', async () => {
    // Shares of R$ 2.500 are HGLG11 40 %, ITSA4 40 %, CDB 20 %.
    const report = await build('asset_class');

    expect(report.concentration.thresholdPct).toBe(20);
    expect(report.rows.filter((row) => row.concentrated).map((row) => row.assetCode)).toEqual([
      'HGLG11',
      'ITSA4',
    ]);
  });

  it('changing the threshold changes which holdings flag', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = await query('asset_class', { kind: 'portfolio' });
    const opening = await port.findSnapshotBefore(result.range.from);

    const at = (thresholdPct: number) =>
      buildCompositionReport({
        query: result,
        opening,
        thresholdPct,
        quotedAt: null,
        delayMinutes: 30,
      })
        .rows.filter((row) => row.concentrated)
        .map((row) => row.assetCode);

    // At 40 nothing *exceeds* 40 % — BR-015-05 says exceeds, and both large
    // holdings sit exactly on it.
    expect(at(40)).toEqual([]);
    expect(at(20)).toEqual(['HGLG11', 'ITSA4']);
    expect(at(10)).toEqual(['HGLG11', 'ITSA4', 'CDB-X']);
  });
});

describe('SPEC-015 AC — BR-015-04: drift, and BR-015-13: quote freshness', () => {
  it('reports the allocation shift by asset class against the baseline snapshot', async () => {
    /**
     * The baseline is 2026-01-05: 200 stock, 600 fii, 200 cdb of 1.000 —
     * 20 / 60 / 20. Today the holdings are 1.000 / 1.000 / 500 of 2.500 —
     * 40 / 40 / 20. So stock gained twenty points of the portfolio, fii shed
     * twenty, and cdb did not move at all despite its value rising: the point
     * BR-015-04 is about, and the reason drift is measured in shares.
     *
     * The period is YTD from 2026-01-01, and the fixture's first snapshot is
     * *inside* it, so `findSnapshotBefore` finds nothing — which is the
     * refusal, not the drift. The baseline below therefore comes from a range
     * that opens after it.
     */
    const port = new FakeReportDataPort(fixture());
    const result = await runReportQuery(
      port,
      {
        period: { kind: 'custom', from: day('2026-06-01'), to: TODAY },
        scope: { kind: 'portfolio' },
        grouping: 'asset_class',
        today: TODAY,
      },
      day('2026-01-01'),
    );
    if (!result.ok) throw new Error(result.error.code);

    const report = buildCompositionReport({
      query: result.value,
      opening: await port.findSnapshotBefore(result.value.range.from),
      thresholdPct: 20,
      quotedAt: null,
      delayMinutes: 30,
    });

    if (report.drift.kind === 'unavailable') throw new Error(report.drift.reason);
    const stock = report.drift.value.find((shift) => shift.key.id === 'stock');
    expect(stock?.opening.toString()).toBe('0.2');
    expect(stock?.closing.toString()).toBe('0.4');
    expect(stock?.change.toString()).toBe('0.2');

    const fii = report.drift.value.find((shift) => shift.key.id === 'fii');
    expect(fii?.change.toString()).toBe('-0.2');

    // Unmoved allocation, moved value: the cdb went from R$ 200 to R$ 500 and
    // is 20 % of the portfolio at both ends.
    const cdb = report.drift.value.find((shift) => shift.key.id === 'cdb');
    expect(cdb?.change.isZero()).toBe(true);
  });

  it('refuses drift at wallet scope rather than lending it the portfolio history', async () => {
    const report = await build('asset_class', { kind: 'wallet', walletId: walletA });

    expect(report.drift.kind).toBe('unavailable');
    expect(report.drift.kind === 'unavailable' && report.drift.reason).toBe(
      HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED,
    );
  });

  it('BR-015-13: carries the valuation date, the quote instant and the delay tier', async () => {
    const report = await build('asset_class');

    expect(report.quotes.valuationAsOf).toBe('2026-08-14');
    expect(report.quotes.quotedAt?.toISOString()).toBe('2026-08-14T17:30:00.000Z');
    // SPEC-008 BR-008-04: the tier is stated so the product never implies
    // real-time.
    expect(report.quotes.delayMinutes).toBe(30);
  });
});
