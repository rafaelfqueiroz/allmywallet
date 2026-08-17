import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { walletIdOf } from '@/core/reporting/test-support';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import type { ReportQueryResult } from '@/core/reporting/base-query';
import { buildPortfolioValueReport } from './report';

/** TEMPORARY — documents the defect before it is fixed. Deleted after. */

const d = (v: string): BusinessDate => BusinessDate.of(v);
const m = (v: string): Money => Money.fromString(v);

function snap(date: string, total: string, contributions: string): DailyValuationSnapshot {
  return {
    date: d(date),
    totalValue: m(total),
    netContributions: m(contributions),
    earningsToDate: Money.zero(),
    byAssetClass: new Map(),
    hasEstimates: false,
  };
}

describe('the defect', () => {
  it('shows −97,5 %', () => {
    const query: ReportQueryResult = {
      range: { from: d('2026-03-01'), to: d('2026-03-31') },
      asOf: d('2026-03-31'),
      scope: {
        scope: { kind: 'wallet', walletId: walletIdOf('1') },
        wallet: { walletId: walletIdOf('1'), name: 'Reserva' },
      },
      report: {
        grouping: 'asset_class',
        groups: [],
        total: {
          value: m('10000'),
          costBasis: m('10000'),
          quantity: Quantity.fromString('1'),
          estimated: false,
        },
      },
      snapshots: [snap('2026-03-30', '400000', '400000'), snap('2026-03-31', '400000', '400000')],
      empty: false,
    };

    const report = buildPortfolioValueReport({
      query,
      opening: snap('2026-02-28', '400000', '400000'),
      grouping: 'asset_class',
      today: d('2026-03-31'),
      lastImportAt: null,
    });

    // eslint-disable-next-line no-console
    console.log({
      totalInvested: report.headline.totalInvested.toString(),
      absoluteGain: report.headline.absoluteGain.toString(),
      gainRatio: report.headline.gainRatio?.toString(),
      series: report.series.map((p) => `${p.date}=${p.value.toString()}`),
      monthly: report.monthlyContributions.map((b) => `${b.month}=${b.amount.toString()}`),
      stacked: report.stacked.kind,
      decompositionClosing: report.decomposition.closing.toString(),
    });

    expect(report.headline.gainRatio?.toString()).toBe('-0.975');
  });
});
