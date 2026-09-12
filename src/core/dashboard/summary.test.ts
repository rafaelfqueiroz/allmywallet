import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import {
  FakeReportDataPort,
  anAsset,
  aPosition,
  assetIdOf,
  day,
  money,
  qty,
} from '@/core/reporting/test-support';
import type { ImportRowAttentionCount } from '@/core/ingestion/ports';
import type { Discrepancy, ReconciliationReport } from '@/core/ingestion/reconcile';
import type { PendingAllocation } from '@/core/wallets/pending';
import {
  buildDashboardSummary,
  reconciliationStatus,
  type AssetLabel,
  type DashboardSummaryInput,
  type ReconciliationSource,
} from '@/core/dashboard/summary';

/**
 * #98 — the dashboard read model.
 *
 * TS-01: no database. Every input is either a hand-built record or the real
 * `runReportQuery` over the hand-written `FakeReportDataPort`, which is what
 * makes "the dashboard's headline is the report's own figure" an assertion
 * about the production code path rather than about a fixture.
 */

const TODAY = day('2026-09-12');
const PETR = assetIdOf('1');
const VALE = assetIdOf('2');

/** A one-day query at portfolio scope — exactly what the loader runs. */
async function queryFor(
  positions: Parameters<typeof aPosition>[0][],
  assets = [
    anAsset({ assetId: PETR, code: 'PETR4', name: 'Petrobras PN' }),
    anAsset({ assetId: VALE, code: 'VALE3', name: 'Vale ON' }),
  ],
): Promise<ReportQueryResult> {
  const port = new FakeReportDataPort({
    positions: positions.map(aPosition),
    allocations: [],
    wallets: [],
    institutions: [],
    assets,
    snapshots: [],
  });
  const result = await runReportQuery(
    port,
    {
      period: { kind: 'custom', from: TODAY, to: TODAY },
      scope: { kind: 'portfolio' },
      grouping: 'asset_class',
      today: TODAY,
    },
    TODAY,
  );
  if (!result.ok) throw new Error(`fixture query failed: ${result.error.code}`);
  return result.value;
}

const LABELS: ReadonlyMap<AssetId, AssetLabel> = new Map([
  [PETR, { code: 'PETR4', name: 'Petrobras PN' }],
  [VALE, { code: 'VALE3', name: 'Vale ON' }],
]);

function input(overrides: Partial<DashboardSummaryInput> & { query: ReportQueryResult }) {
  return {
    quotedAt: null,
    delayMinutes: 30,
    lastImportAt: day('2026-09-10'),
    thresholdDays: 30,
    today: TODAY,
    reconciliation: null,
    pending: [] as readonly PendingAllocation[],
    unclassified: [] as readonly ImportRowAttentionCount[],
    assetLabels: LABELS,
    ...overrides,
  } satisfies DashboardSummaryInput;
}

const BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000d1');

function aDiscrepancy(overrides: Partial<Discrepancy>): Discrepancy {
  return {
    assetId: PETR,
    assetCode: 'PETR4',
    institutionId: null,
    computedQuantity: '100',
    b3Quantity: '120',
    difference: '20',
    cause: 'missing_history_before_import_range',
    resolved: false,
    ...overrides,
  };
}

function aReport(overrides: Partial<ReconciliationReport>): ReconciliationReport {
  return {
    asOf: day('2026-09-10'),
    discrepancies: [],
    status: 'reconciled',
    ...overrides,
  };
}

const sourceOf = (report: ReconciliationReport): ReconciliationSource => ({
  batchId: BATCH,
  report,
});

// ---------------------------------------------------------------------------

describe('portfolio value (BR-020-27, BR-011-16, BR-013-12)', () => {
  it('is the report query total, not a second computation of it', async () => {
    // Hand-computed: 100 × R$ 10,00 + 50 × R$ 20,00 = 1.000 + 1.000 = R$ 2.000,00.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('800') },
      { assetId: VALE, quantity: qty('50'), value: money('1000'), costBasis: money('900') },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toEqual({
      kind: 'valued',
      value: Money.fromString('2000'),
      estimated: false,
    });
    // The identity that makes the dashboard and the Patrimônio report unable to
    // disagree: it is literally the same object, not an equal one.
    expect(summary.portfolio).toMatchObject({ value: query.report.total.value });
  });

  it('marks the figure estimated when any component is accrued rather than observed', async () => {
    // BR-011-15 / CR-1: one accrued component is enough.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('800') },
      {
        assetId: VALE,
        quantity: qty('50'),
        value: money('1000'),
        costBasis: money('900'),
        estimated: true,
      },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toEqual({
      kind: 'valued',
      value: Money.fromString('2000'),
      estimated: true,
    });
  });

  it('shows the onboarding empty state, never a zero, before the first import', async () => {
    const query = await queryFor([]);

    const summary = buildDashboardSummary(input({ query, lastImportAt: null }));

    // BR-020-27: not `{ kind: 'valued', value: 0 }`.
    expect(summary.portfolio).toEqual({ kind: 'onboarding' });
  });

  it('distinguishes an empty portfolio from a first run once an import exists', async () => {
    const query = await queryFor([]);

    const summary = buildDashboardSummary(input({ query, lastImportAt: day('2026-01-05') }));

    // Telling this user to import their extract would be telling them to redo
    // something they have already done.
    expect(summary.portfolio).toEqual({ kind: 'no_holdings' });
  });

  it('reports a genuinely worthless holding as a figure, not as an empty state', async () => {
    // A held position priced at zero is a fact about the money; an empty state
    // would be the opposite claim.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('0'), costBasis: money('800') },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toEqual({
      kind: 'valued',
      value: Money.zero(),
      estimated: false,
    });
  });
});

describe('freshness (BR-005-27/28, BR-008-04, BR-013-13)', () => {
  it('carries the valuation date, the quote instant and the delay tier', async () => {
    const quotedAt = new Date('2026-09-12T17:05:00Z');
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(input({ query, quotedAt, delayMinutes: 30 }));

    expect(summary.freshness.valuationAsOf).toBe(TODAY);
    expect(summary.freshness.quotedAt).toBe(quotedAt);
    expect(summary.freshness.delayMinutes).toBe(30);
  });

  it('leaves the quote instant null when nothing held is priced by a live quote', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(input({ query, quotedAt: null }));

    expect(summary.freshness.quotedAt).toBeNull();
  });

  it('is not stale inside the user own threshold', async () => {
    // 2026-09-12 − 2026-08-20 = 12 days in August + 12 in September = 23 days.
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({ query, lastImportAt: day('2026-08-20'), thresholdDays: 30 }),
    );

    expect(summary.freshness.daysSinceImport).toBe(23);
    expect(summary.freshness.stale).toBe(false);
    expect(summary.freshness.thresholdDays).toBe(30);
  });

  it('is stale once the threshold is exceeded', async () => {
    // 2026-09-12 − 2026-07-01 = 30 (July) + 31 (August) + 12 = 73 days.
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({ query, lastImportAt: day('2026-07-01'), thresholdDays: 30 }),
    );

    expect(summary.freshness.daysSinceImport).toBe(73);
    expect(summary.freshness.stale).toBe(true);
  });

  it('treats never-imported as stale, with no number of days to report', async () => {
    const query = await queryFor([]);

    const summary = buildDashboardSummary(input({ query, lastImportAt: null }));

    expect(summary.freshness.lastImportAt).toBeNull();
    expect(summary.freshness.daysSinceImport).toBeNull();
    // `staleness.ts`: "never" is the strongest case for the prompt, not the weakest.
    expect(summary.freshness.stale).toBe(true);
  });
});

describe('reconciliation status (BR-005-26)', () => {
  it('reports never_reconciled when no Posição batch has ever been committed', () => {
    expect(reconciliationStatus(null)).toEqual({
      state: 'never_reconciled',
      asOf: null,
      unresolvedCount: 0,
      batchId: null,
    });
  });

  it('reports reconciled when the comparison found nothing', () => {
    expect(reconciliationStatus(sourceOf(aReport({ discrepancies: [] })))).toEqual({
      state: 'reconciled',
      asOf: BusinessDate.of('2026-09-10'),
      unresolvedCount: 0,
      batchId: BATCH,
    });
  });

  it('reports discrepancies_found and counts only the unresolved ones', () => {
    const report = aReport({
      status: 'discrepancies_found',
      discrepancies: [
        aDiscrepancy({ assetCode: 'PETR4', resolved: false }),
        aDiscrepancy({ assetCode: 'VALE3', resolved: true }),
        aDiscrepancy({ assetCode: 'ITSA4', resolved: false }),
      ],
    });

    expect(reconciliationStatus(sourceOf(report))).toEqual({
      state: 'discrepancies_found',
      asOf: BusinessDate.of('2026-09-10'),
      unresolvedCount: 2,
      batchId: BATCH,
    });
  });

  it('returns to reconciled once every discrepancy has been accepted', () => {
    /*
     * BR-005-25: `accept-adjustment.ts` flips `resolved` and deliberately
     * leaves the batch's stored `status` at `discrepancies_found`, because the
     * import really did find a disagreement. The dashboard answers about *now*,
     * so a permanent badge with nothing behind it is the failure this asserts
     * against.
     */
    const report = aReport({
      status: 'discrepancies_found',
      discrepancies: [
        aDiscrepancy({ assetCode: 'PETR4', resolved: true }),
        aDiscrepancy({ assetCode: 'VALE3', resolved: true }),
      ],
    });

    expect(reconciliationStatus(sourceOf(report))).toMatchObject({
      state: 'reconciled',
      unresolvedCount: 0,
    });
  });

  it('is carried onto the assembled summary', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({ query, reconciliation: sourceOf(aReport({ discrepancies: [aDiscrepancy({})] })) }),
    );

    expect(summary.reconciliation.state).toBe('discrepancies_found');
    expect(summary.reconciliation.batchId).toBe(BATCH);
  });
});

describe('needs attention (BR-010-12)', () => {
  it('is empty when there is nothing to do', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    expect(buildDashboardSummary(input({ query })).attention).toEqual([]);
  });

  it('lists outstanding import rows before pending allocations', async () => {
    const query = await queryFor([{ assetId: PETR }, { assetId: VALE }]);

    const summary = buildDashboardSummary(
      input({
        query,
        unclassified: [{ batchId: BATCH, count: 3 }],
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
        ],
      }),
    );

    // The item that makes every figure on the screen understated leads the one
    // that changes no figure at all.
    expect(summary.attention).toEqual([
      { kind: 'import_rows', batchId: BATCH, count: 3 },
      {
        kind: 'pending_allocation',
        assetId: PETR,
        assetCode: 'PETR4',
        quantity: Quantity.fromString('40'),
        reason: 'no_wallet',
      },
    ]);
  });

  it('carries each pending reason so the queue can say why', async () => {
    const query = await queryFor([{ assetId: PETR }, { assetId: VALE }]);

    const summary = buildDashboardSummary(
      input({
        query,
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
          {
            assetId: VALE,
            unassignedQuantity: Quantity.fromString('5'),
            reason: 'ambiguous_split',
          },
        ],
      }),
    );

    expect(
      summary.attention.map((item) => item.kind === 'pending_allocation' && item.reason),
    ).toEqual(['no_wallet', 'ambiguous_split']);
  });

  it('drops a batch with no unclassified rows rather than listing a zero', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({ query, unclassified: [{ batchId: BATCH, count: 0 }] }),
    );

    // An empty queue has to be able to mean "nothing to do".
    expect(summary.attention).toEqual([]);
  });

  it('still surfaces a pending holding whose label cannot be resolved', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        assetLabels: new Map(),
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
        ],
      }),
    );

    // Vanishing the item would hide work the user has to do; a missing name is
    // the lesser failure.
    expect(summary.attention).toEqual([
      {
        kind: 'pending_allocation',
        assetId: PETR,
        assetCode: null,
        quantity: Quantity.fromString('40'),
        reason: 'no_wallet',
      },
    ]);
  });
});
