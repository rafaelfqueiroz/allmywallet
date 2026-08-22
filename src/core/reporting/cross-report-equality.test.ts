import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import { Money } from '@/core/shared/money';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import { buildCompositionReport } from '@/core/reporting/composition/report';
import { buildPortfolioValueReport } from '@/core/reporting/portfolio-value/report';
import {
  GROUPINGS,
  type DailyValuationSnapshot,
  type Grouping,
  type Period,
  type Scope,
} from '@/core/reporting/ports';
import {
  FakeReportDataPort,
  generatePortfolio,
  institutionIdOf,
  scopesFor,
  day,
  type FakeReportData,
  type GeneratedPortfolio,
} from '@/core/reporting/test-support';

/**
 * SPEC-013 BR-013-12 / DL-013-06 — **the two reports must agree about how much
 * money the user has.**
 *
 * "Two reports disagreeing about how much money the user has is the single most
 * trust-destroying defect this product could ship", and the answer DL-013-06
 * chose was not a reconciliation step but an explicit cross-report assertion.
 * This is that assertion.
 *
 * The equality is *structural* today: both reports fold the same
 * `runReportQuery` result and neither re-adds the holdings — `aggregate` sums
 * them once, `composition/report.ts` takes `query.report.total` unchanged, and
 * `portfolio-value/report.ts` headlines the same object. A reader can verify
 * that by inspection, and that is exactly why it needs a test: structure is
 * one refactor away from stopping being true, and the failure mode is silent.
 * The day someone gives either report its own summation — a rounding pass, a
 * "corrected" total that excludes needs-attention holdings, a share
 * denominator reused as a total — this fails, rather than a support ticket
 * arriving months later saying the two screens disagree by four centavos.
 *
 * **Wallet scope is included deliberately.** It is where the two reports have
 * most room to diverge: `portfolio-value` refuses every snapshot-derived
 * figure there (`WALLET_SCOPE_NOT_SNAPSHOTTED`) while still headlining the
 * wallet's own value, and the −97,5 % gain recorded in that file's header is
 * what mixing the two grains produces. The headline must remain the *scoped*
 * total, which is the number Composition shows.
 *
 * TS-04: exact `Money` equality throughout. An approximate comparison would
 * step over the rounding-drift class this framework's arithmetic is most
 * exposed to — which is the same reason `totals-invariant.test.ts` insists on
 * it, and this test shares that file's generated portfolios for the same
 * reason.
 */

const TODAY = day('2026-08-14');

/** SPEC-002 `reports.concentration_threshold_pct` — irrelevant to the total, and set anyway. */
const THRESHOLD_PCT = 20;

/**
 * The snapshot series, built from the positions rather than invented.
 *
 * `totalValue` is Σ position value and `byAssetClass` its decomposition, so
 * the stored history agrees with the valued holdings the way a real pipeline's
 * would. A fixture where they disagree would make this test measure snapshot
 * staleness instead of cross-report equality — a different, and much weaker,
 * property.
 */
function snapshotsFor(portfolio: GeneratedPortfolio, dates: readonly string[]) {
  const classOf = new Map<string, AssetClass>(
    portfolio.assets.map((asset) => [asset.assetId, asset.assetClass]),
  );

  let total = Money.zero();
  const byAssetClass = new Map<AssetClass, Money>();
  let hasEstimates = false;

  for (const position of portfolio.positions) {
    total = total.plus(position.value);
    hasEstimates = hasEstimates || position.estimated;
    const assetClass = classOf.get(position.assetId);
    if (assetClass === undefined) continue;
    byAssetClass.set(
      assetClass,
      (byAssetClass.get(assetClass) ?? Money.zero()).plus(position.value),
    );
  }

  return dates.map((date): DailyValuationSnapshot => ({
    date: day(date),
    totalValue: total,
    netContributions: Money.fromString('1000'),
    earningsToDate: Money.fromString('10'),
    byAssetClass: new Map(byAssetClass),
    hasEstimates,
  }));
}

function fixtureFor(portfolio: GeneratedPortfolio, dates: readonly string[]): FakeReportData {
  return {
    positions: portfolio.positions,
    allocations: portfolio.allocations,
    wallets: portfolio.walletIds.map((walletId, index) => ({
      walletId,
      name: `Carteira ${index + 1}`,
    })),
    institutions: [
      { institutionId: institutionIdOf('1'), name: 'XP' },
      { institutionId: institutionIdOf('2'), name: 'Rico' },
    ],
    assets: portfolio.assets,
    snapshots: snapshotsFor(portfolio, dates),
  };
}

async function query(
  portfolio: GeneratedPortfolio,
  dates: readonly string[],
  input: { readonly period: Period; readonly scope: Scope; readonly grouping: Grouping },
): Promise<ReportQueryResult> {
  const port = new FakeReportDataPort(fixtureFor(portfolio, dates));
  const result = await runReportQuery(port, { ...input, today: TODAY }, day(dates[0] as string));
  if (!result.ok) throw new Error(`report query failed: ${result.error.code}`);
  return result.value;
}

/** Both reports, folded from one query — which is the property under test. */
function bothReports(result: ReportQueryResult, grouping: Grouping) {
  return {
    patrimonio: buildPortfolioValueReport({
      query: result,
      opening: null,
      grouping,
      today: TODAY,
      lastImportAt: day('2026-08-13'),
    }),
    composicao: buildCompositionReport({
      query: result,
      opening: null,
      thresholdPct: THRESHOLD_PCT,
      quotedAt: null,
      delayMinutes: 30,
    }),
  };
}

const SNAPSHOT_DATES = ['2026-01-05', '2026-04-30', '2026-08-14'] as const;
const SEEDS = [1, 7, 42, 20260814] as const;

describe('BR-013-12 — Patrimônio and Composição report the same total', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every scope × grouping agrees, to the centavo`, async () => {
      const portfolio = generatePortfolio(seed);

      for (const scope of scopesFor(portfolio.walletIds)) {
        for (const grouping of GROUPINGS) {
          const result = await query(portfolio, SNAPSHOT_DATES, {
            period: { kind: 'ytd' },
            scope,
            grouping,
          });
          const { patrimonio, composicao } = bothReports(result, grouping);

          const headline = patrimonio.headline.currentValue;
          const total = composicao.total.value;

          expect(
            headline.equals(total),
            `${scope.kind}/${grouping}: patrimônio ${headline.toString()} vs composição ${total.toString()}`,
          ).toBe(true);
        }
      }
    });
  }

  /**
   * The literal wording of the rule: it is the *chart's endpoint* that has to
   * match, not merely a headline figure computed beside it. `withLiveEndpoint`
   * is what makes those the same point, and it is the piece a future change to
   * the series is most likely to break.
   */
  it('the chart’s endpoint is the Composição total, not merely close to it', async () => {
    const portfolio = generatePortfolio(11);
    const result = await query(portfolio, SNAPSHOT_DATES, {
      period: { kind: 'ytd' },
      scope: { kind: 'portfolio' },
      grouping: 'asset_class',
    });
    const { patrimonio, composicao } = bothReports(result, 'asset_class');

    if (patrimonio.series.kind !== 'available') throw new Error('expected a portfolio series');
    const endpoint = patrimonio.series.value.at(-1);

    expect(endpoint).toBeDefined();
    expect(endpoint?.date).toBe(result.asOf);
    expect(endpoint?.value.equals(composicao.total.value)).toBe(true);
  });

  /**
   * A report *about a past date* has no live endpoint to splice, so the line
   * ends on that date's stored close. The rule says "for the same scope and
   * date", and this is the other half of it: the two reports must agree on a
   * historical date too, reading the snapshot rather than today's valuation.
   */
  it('agrees on a historical date, where the endpoint is the stored close', async () => {
    const portfolio = generatePortfolio(3);
    const result = await query(portfolio, SNAPSHOT_DATES, {
      period: { kind: 'custom', from: day('2026-01-01'), to: day('2026-04-30') },
      scope: { kind: 'portfolio' },
      grouping: 'asset_class',
    });
    const { patrimonio, composicao } = bothReports(result, 'asset_class');

    expect(result.asOf).toBe('2026-04-30');
    if (patrimonio.series.kind !== 'available') throw new Error('expected a portfolio series');

    const endpoint = patrimonio.series.value.at(-1);
    expect(endpoint?.date).toBe('2026-04-30');
    expect(endpoint?.value.equals(composicao.total.value)).toBe(true);
    expect(patrimonio.headline.currentValue.equals(composicao.total.value)).toBe(true);
  });

  /**
   * Where the two reports have the most room to diverge. `portfolio-value`
   * refuses every snapshot-derived figure at wallet scope; the headline must
   * survive that refusal as the *wallet's* money, which is what Composição
   * totals for the same scope.
   */
  it('agrees at wallet scope, where Patrimônio refuses its history', async () => {
    const portfolio = generatePortfolio(42);
    const walletId = portfolio.walletIds[0];
    if (walletId === undefined) throw new Error('the generator produced no wallets');

    const result = await query(portfolio, SNAPSHOT_DATES, {
      period: { kind: 'ytd' },
      scope: { kind: 'wallet', walletId },
      grouping: 'asset',
    });
    const { patrimonio, composicao } = bothReports(result, 'asset');

    expect(patrimonio.series.kind).toBe('unavailable');
    expect(patrimonio.headline.currentValue.equals(composicao.total.value)).toBe(true);

    // And it is the *wallet's* money, not the portfolio's — the failure the
    // refusal exists to prevent would satisfy the equality above only by
    // making both reports wrong in the same direction.
    const portfolioWide = await query(portfolio, SNAPSHOT_DATES, {
      period: { kind: 'ytd' },
      scope: { kind: 'portfolio' },
      grouping: 'asset',
    });
    expect(patrimonio.headline.currentValue.equals(portfolioWide.report.total.value)).toBe(false);
  });
});
