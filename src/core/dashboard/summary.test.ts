import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { ImportBatchId, ImportRowId, type AssetId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import type { EarningRecord, ReportAllocation } from '@/core/reporting/ports';
import type { DailyValuationSnapshot } from '@/core/valuation/ports';
import {
  FakeReportDataPort,
  anAsset,
  aPosition,
  assetIdOf,
  day,
  institutionIdOf,
  money,
  qty,
  walletIdOf,
} from '@/core/reporting/test-support';
import type {
  ImportRow,
  NeedsAttentionRow,
  NormalizedTransactionRecord,
} from '@/core/ingestion/ports';
import type { Discrepancy, ReconciliationReport } from '@/core/ingestion/reconcile';
import type { ContractMissingRate } from '@/core/onboarding/ports';
import type { PendingAllocation } from '@/core/wallets/pending';
import {
  ATTENTION_QUEUE_LIMIT,
  buildDashboardSummary,
  dashboardMonths,
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
const WALLET_A = walletIdOf('1');
const WALLET_B = walletIdOf('2');
const WALLET_C = walletIdOf('3');

/** A one-day query at portfolio scope — exactly what the loader runs. */
async function queryFor(
  positions: Parameters<typeof aPosition>[0][],
  assets = [
    anAsset({ assetId: PETR, code: 'PETR4', name: 'Petrobras PN' }),
    anAsset({ assetId: VALE, code: 'VALE3', name: 'Vale ON' }),
  ],
  /**
   * Allocations matter to exactly one assertion — the wallet-slice fan-out that
   * `buildHoldingSet` produces — so they default to none and that test passes
   * them explicitly, which keeps the fan-out visible where it is the subject.
   */
  allocations: ReportAllocation[] = [],
): Promise<ReportQueryResult> {
  const port = new FakeReportDataPort({
    positions: positions.map(aPosition),
    allocations,
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
    earliestSnapshot: null,
    monthEnd: null,
    earnings: { current: [] as readonly EarningRecord[], previous: [] as readonly EarningRecord[] },
    hasEverHeldAnything: false,
    thresholdDays: 30,
    today: TODAY,
    reconciliation: null,
    pending: [] as readonly PendingAllocation[],
    importRows: [] as readonly NeedsAttentionRow[],
    contractsMissingRate: [] as readonly ContractMissingRate[],
    assetLabels: LABELS,
    ...overrides,
  } satisfies DashboardSummaryInput;
}

const BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000d1');
const OTHER_BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000d2');

/**
 * `count` outstanding rows of one asset and movement. `current` is the stored
 * record unless a re-reading is given, as the loader passes it when the
 * current parser reads the row no differently.
 */
function attentionRows(
  count: number,
  {
    batchId = BATCH,
    assetCode = 'PETR4',
    b3Type = 'Um Tipo Novo',
    classification = 'unclassified',
    reread,
  }: {
    batchId?: ImportBatchId;
    assetCode?: string;
    b3Type?: string;
    classification?: ImportRow['classification'];
    reread?: Partial<NormalizedTransactionRecord>;
  } = {},
): NeedsAttentionRow[] {
  return Array.from({ length: count }, () => {
    const record: NormalizedTransactionRecord = {
      kind: 'transaction',
      b3Type,
      direction: 'credit',
      assetCode,
      assetName: assetCode,
      assetClass: 'stock',
      institutionName: 'Corretora Teste',
      tradeDate: day('2026-09-01'),
      quantity: qty('10'),
      unitPrice: money('1'),
      priceStated: true,
      fees: Money.zero(),
      ratio: null,
    };
    return {
      row: {
        id: ImportRowId.generate(),
        batchId,
        raw: {},
        record,
        assetId: PETR,
        institutionId: null,
        classification,
        naturalKey: null,
        occurrence: null,
        ledgerType: null,
        transactionId: null,
      },
      source: 'b3_movimentacao',
      storedCopyUserModified: false,
      current: { ...record, ...reread },
    };
  });
}

/** What `attentionRows(3)` becomes in the queue. */
const THREE_UNMAPPED_ROWS = {
  kind: 'import_rows',
  batchId: BATCH,
  resolution: 'no_rule',
  count: 3,
  movements: [{ assetCode: 'PETR4', movement: 'Um Tipo Novo', count: 3 }],
} as const;

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

    expect(summary.portfolio).toMatchObject({
      kind: 'valued',
      value: Money.fromString('2000'),
      markers: { estimated: false, accrued: false, unpriced: 0, carriedForward: false },
    });
    // The identity that makes the dashboard and the Patrimônio report unable to
    // disagree: it is literally the same object, not an equal one.
    expect(summary.portfolio).toMatchObject({ value: query.report.total.value });
  });

  it('carries the report’s cost and the unrealised result over it (SPEC-022 BR-022-07)', async () => {
    // Hand-computed: cost 800 + 900 = R$ 1.700,00; result 2.000 − 1.700 =
    // R$ 300,00; ratio 300 / 1.700 (a fraction, not ×100).
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('800') },
      { assetId: VALE, quantity: qty('50'), value: money('1000'), costBasis: money('900') },
    ]);

    const summary = buildDashboardSummary(input({ query }));
    if (summary.portfolio.kind !== 'valued') throw new Error('expected a valued portfolio');

    expect(summary.portfolio.costBasis.equals(Money.fromString('1700'))).toBe(true);
    expect(summary.portfolio.costEstimated).toBe(false);
    expect(summary.portfolio.result.result.equals(Money.fromString('300'))).toBe(true);
    expect(
      summary.portfolio.result.ratio?.equals(
        Money.fromString('300').dividedBy(Money.fromString('1700').toDecimal()),
      ),
    ).toBe(true);
    // The report's own figure, not an equal recomputation (BR-013-12).
    expect(summary.portfolio.costBasis).toBe(query.report.total.costBasis);
  });

  it('marks the figure accrued when a contract-based component is in it', async () => {
    // BR-011-15 / BR-009-11: one accrued component is enough. `basis` is the
    // accrual's own evidence, and its presence is what separates this from the
    // cost fallback below.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('800') },
      {
        assetId: VALE,
        quantity: qty('50'),
        value: money('1000'),
        costBasis: money('900'),
        estimated: true,
        basis: {
          indexer: 'cdi_percent',
          ratePercent: '110',
          businessDays: 20,
          throughDate: day('2026-09-12'),
          matured: false,
          missingIndexDays: 0,
        },
      },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toMatchObject({
      kind: 'valued',
      value: Money.fromString('2000'),
      markers: { estimated: true, accrued: true, unpriced: 0, carriedForward: false },
    });
  });

  /**
   * SPEC-009 BR-009-13 — nothing could price this holding, so it sits at
   * acquisition cost. `estimated` is true for the same reason accrual sets it,
   * and telling the user the caveat comes from *renda fixa acruada* they do not
   * own would be a false explanation of a true warning. `HoldingMarkers` makes
   * the same distinction per row; this is it at portfolio grain.
   */
  it('tells a cost fallback apart from an accrual', async () => {
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('800') },
      {
        assetId: VALE,
        quantity: qty('50'),
        value: money('900'),
        costBasis: money('900'),
        estimated: true,
        // No `basis`: nothing was accrued, the price simply could not be found.
        basis: null,
        needsAttention: 'PRICE_UNAVAILABLE',
        priceDate: null,
      },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toMatchObject({
      markers: { estimated: true, accrued: false, unpriced: 1, carriedForward: false },
    });
  });

  /**
   * BR-009-03 / BR-008-24 — an observed close from an earlier date is not an
   * estimate, and must not be shown as current either. The **oldest** such date
   * is what the screen needs: `quotedAt` is already the freshest quote across
   * the portfolio, so a screen carrying only that reports half an hour of delay
   * over holdings that are weeks behind the market.
   */
  it('reports the oldest carried-forward price date, not the newest', async () => {
    const query = await queryFor([
      {
        assetId: PETR,
        quantity: qty('100'),
        value: money('1000'),
        costBasis: money('800'),
        carriedForward: true,
        priceDate: day('2026-08-21'),
      },
      {
        assetId: VALE,
        quantity: qty('50'),
        value: money('1000'),
        costBasis: money('900'),
        carriedForward: true,
        priceDate: day('2026-09-11'),
      },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toMatchObject({
      markers: {
        // A carried-forward close is a real observed price, so it is not an
        // estimate — folding it in would mark every Saturday's whole portfolio.
        estimated: false,
        accrued: false,
        unpriced: 0,
        carriedForward: true,
        oldestPriceDate: '2026-08-21',
      },
    });
  });

  /**
   * `buildHoldingSet` emits one `ReportHolding` per **wallet slice** of a
   * position and copies `needsAttention` onto each slice unchanged, on purpose:
   * value and quantity divide between carteiras, how the price was obtained
   * does not. So one unpriceable CDB filed across three wallets is three
   * holdings — and counting holdings told the user "3 posições não puderam ser
   * precificadas" about a single position, with no row beneath the badge to
   * reconcile that against.
   */
  it('counts one unpriced position, not one per wallet it is filed in', async () => {
    const query = await queryFor(
      [
        {
          assetId: VALE,
          quantity: qty('300'),
          value: money('300'),
          costBasis: money('300'),
          estimated: true,
          basis: null,
          needsAttention: 'PRICE_UNAVAILABLE',
          priceDate: null,
        },
      ],
      undefined,
      // The same 300 units, split across three carteiras.
      [
        { walletId: WALLET_A, assetId: VALE, quantity: Quantity.fromString('100') },
        { walletId: WALLET_B, assetId: VALE, quantity: Quantity.fromString('100') },
        { walletId: WALLET_C, assetId: VALE, quantity: Quantity.fromString('100') },
      ],
    );

    // Three holdings in, one position out.
    expect(query.report.groups.flatMap((group) => group.holdings)).toHaveLength(3);
    expect(buildDashboardSummary(input({ query })).portfolio).toMatchObject({
      markers: { unpriced: 1, estimated: true, accrued: false },
    });
  });

  /**
   * The other half of the grain: SPEC-007 BR-007-08 stores one position per
   * `(asset, institution)`, and an institution is legitimately **null** — the
   * reference workload's rows all are, and a manual entry need not name a
   * broker. Two unpriceable rows for the same asset at different custodians are
   * two positions the user can go and look at, so they count as two.
   */
  it('counts positions per custodian, including the one with no institution', async () => {
    const query = await queryFor([
      {
        assetId: VALE,
        institutionId: institutionIdOf('7'),
        quantity: qty('100'),
        value: money('100'),
        costBasis: money('100'),
        estimated: true,
        basis: null,
        needsAttention: 'PRICE_UNAVAILABLE',
        priceDate: null,
      },
      {
        assetId: VALE,
        institutionId: null,
        quantity: qty('50'),
        value: money('50'),
        costBasis: money('50'),
        estimated: true,
        basis: null,
        needsAttention: 'PRICE_UNAVAILABLE',
        priceDate: null,
      },
    ]);

    expect(buildDashboardSummary(input({ query })).portfolio).toMatchObject({
      markers: { unpriced: 2 },
    });
  });

  it('ignores a carried-forward flag with no price date behind it', async () => {
    const query = await queryFor([
      {
        assetId: PETR,
        quantity: qty('100'),
        value: money('1000'),
        costBasis: money('800'),
        carriedForward: true,
        priceDate: null,
      },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    // Nothing to tell the user *from when*, so there is nothing honest to say.
    expect(summary.portfolio).toMatchObject({
      markers: { carriedForward: false, oldestPriceDate: null },
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

  it('shows the onboarding state only when there is no history of any kind', async () => {
    const query = await queryFor([]);

    const summary = buildDashboardSummary(
      input({
        query,
        lastImportAt: null,
        earliestSnapshot: null,
        hasEverHeldAnything: false,
      }),
    );

    expect(summary.portfolio).toEqual({ kind: 'onboarding' });
  });

  it('reports a genuinely worthless holding as a figure, not as an empty state', async () => {
    // A held position priced at zero is a fact about the money; an empty state
    // would be the opposite claim.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('0'), costBasis: money('800') },
    ]);

    const summary = buildDashboardSummary(input({ query }));

    expect(summary.portfolio).toMatchObject({ kind: 'valued', value: Money.zero() });
  });

  /**
   * SPEC-020 BR-020-26 — assets outside B3 custody are entered by hand, and
   * `/transactions/new` exists for exactly that. A user who typed their whole
   * ledger and has since closed every position has no import and no holding;
   * telling them their *patrimônio* "aparece depois da primeira importação"
   * denies them years of their own data.
   */
  it('does not call a manual-entry user a first run', async () => {
    const query = await queryFor([]);

    // Three independent traces of history, none of them the ledger (BR-016-05).
    for (const history of [
      { hasEverHeldAnything: true },
      { earliestSnapshot: day('2024-01-05') },
      { lastImportAt: day('2024-01-05') },
    ]) {
      const summary = buildDashboardSummary(input({ query, lastImportAt: null, ...history }));
      expect(summary.portfolio, JSON.stringify(history)).toEqual({ kind: 'no_holdings' });
    }
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
      resolvedCount: 0,
      batchId: null,
    });
  });

  it('reports reconciled when the comparison found nothing', () => {
    expect(reconciliationStatus(sourceOf(aReport({ discrepancies: [] })))).toEqual({
      state: 'reconciled',
      asOf: BusinessDate.of('2026-09-10'),
      unresolvedCount: 0,
      // Zero accepted, so the screen can say the comparison found nothing —
      // which is a different sentence from "you settled what it found".
      resolvedCount: 0,
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
      resolvedCount: 1,
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
      // The count the screen needs to avoid claiming the comparison found
      // nothing, which is not what happened here.
      resolvedCount: 2,
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
        importRows: attentionRows(3),
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
        ],
      }),
    );

    // The item that makes every figure on the screen understated leads the one
    // that changes no figure at all.
    expect(summary.attention).toEqual([
      THREE_UNMAPPED_ROWS,
      {
        kind: 'pending_allocation',
        assetId: PETR,
        assetCode: 'PETR4',
        quantity: Quantity.fromString('40'),
        reason: 'no_wallet',
      },
    ]);
  });

  /**
   * SPEC-020 BR-020-16/19 — a held fixed-income contract with no readable
   * rate understates the headline exactly as an unclassified row does, so it
   * sits between `import_rows` and `pending_allocation` in the ordering —
   * never a second queue (BR-020-15).
   */
  it('lists a missing fixed-income rate between import rows and pending allocations', async () => {
    const query = await queryFor([{ assetId: PETR }, { assetId: VALE }]);

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: attentionRows(3),
        contractsMissingRate: [{ assetId: VALE, assetCode: 'VALE3', held: true }],
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
        ],
      }),
    );

    expect(summary.attention).toEqual([
      THREE_UNMAPPED_ROWS,
      { kind: 'fixed_income_rate', assetId: VALE, assetCode: 'VALE3', held: true },
      {
        kind: 'pending_allocation',
        assetId: PETR,
        assetCode: 'PETR4',
        quantity: Quantity.fromString('40'),
        reason: 'no_wallet',
      },
    ]);
  });

  /**
   * PR #102 review — a Posição committed before the Movimentação carrying the
   * application leaves a contract with no position, so the holding set has no
   * label for it. The contract's own code is used, and `held` travels with
   * the item so the queue can state the right consequence.
   */
  it('labels a missing rate from the contract when the asset is not in the holding set', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        assetLabels: new Map(),
        contractsMissingRate: [{ assetId: VALE, assetCode: 'CDB-POSICAO', held: false }],
      }),
    );

    expect(summary.attention).toEqual([
      { kind: 'fixed_income_rate', assetId: VALE, assetCode: 'CDB-POSICAO', held: false },
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

  /**
   * SPEC-022 BR-022-35 (#215) — the owner's queue read "14 linhas importadas
   * precisam de revisão": a count and a batch, no asset, no movement and no
   * next step. Each item now names its assets and movements and says what
   * resolves it, one item per batch and resolution.
   */
  it('names each asset and movement and what resolves them, per batch and resolution', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: [
          // Unmapped when staged; the current map ignores it (#196).
          ...attentionRows(2, {
            assetCode: 'Tesouro Selic 2029',
            b3Type: 'Cobrança de Taxa Semestral',
          }),
          // Price-less when staged; the current parser prices it (#192).
          ...attentionRows(1, {
            assetCode: 'GRND3',
            b3Type: 'Dividendo',
            reread: { priceStated: true, priceDerivedFromTotal: true },
          }),
          // Evidence no resolver settled (#158 D8).
          ...attentionRows(1, { assetCode: 'BBAS3', b3Type: 'Atualização' }),
          ...attentionRows(1, { assetCode: 'AXIA7', b3Type: 'Um Tipo Novo' }),
          ...attentionRows(2, { batchId: OTHER_BATCH, assetCode: 'CPLE5', b3Type: 'Atualização' }),
        ],
      }),
    );

    expect(summary.attention).toEqual([
      // A re-import first: the one the user settles without a decision.
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'reimport',
        count: 3,
        movements: [
          { assetCode: 'GRND3', movement: 'Dividendo', count: 1 },
          { assetCode: 'Tesouro Selic 2029', movement: 'Cobrança de Taxa Semestral', count: 2 },
        ],
      },
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'decide',
        count: 1,
        movements: [{ assetCode: 'BBAS3', movement: 'Atualização', count: 1 }],
      },
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'no_rule',
        count: 1,
        movements: [{ assetCode: 'AXIA7', movement: 'Um Tipo Novo', count: 1 }],
      },
      {
        kind: 'import_rows',
        batchId: OTHER_BATCH,
        resolution: 'decide',
        count: 2,
        movements: [{ assetCode: 'CPLE5', movement: 'Atualização', count: 2 }],
      },
    ]);
    expect(summary.attentionTotal).toBe(4);
  });

  it('orders movements by asset code, then by movement, independent of input order', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: [
          // Out of order, then in order, so the order is the sort's own.
          ...attentionRows(1, { assetCode: 'VALE3', b3Type: 'Tipo B' }),
          ...attentionRows(1, { assetCode: 'PETR4', b3Type: 'Tipo A' }),
          ...attentionRows(2, { assetCode: 'PETR4', b3Type: 'Tipo B' }),
        ],
      }),
    );

    expect(summary.attention).toEqual([
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'no_rule',
        count: 4,
        movements: [
          { assetCode: 'PETR4', movement: 'Tipo A', count: 1 },
          { assetCode: 'PETR4', movement: 'Tipo B', count: 2 },
          { assetCode: 'VALE3', movement: 'Tipo B', count: 1 },
        ],
      },
    ]);
  });

  /**
   * Only a movement row can be outstanding, but the record type also admits a
   * Posição row; one that somehow were would still name its asset.
   */
  it('names the asset of a row that carries no movement type', async () => {
    const query = await queryFor([{ assetId: PETR }]);
    const [outstanding] = attentionRows(1);
    if (outstanding === undefined) throw new Error('fixture row missing');
    const position = {
      kind: 'position',
      assetCode: 'PETR4',
      assetName: 'Petrobras PN',
      assetClass: 'stock',
      institutionName: null,
      quantity: qty('10'),
      fixedIncome: null,
    } as const;

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: [
          { ...outstanding, row: { ...outstanding.row, record: position }, current: position },
        ],
      }),
    );

    expect(summary.attention).toEqual([
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'decide',
        count: 1,
        movements: [{ assetCode: 'PETR4', movement: '', count: 1 }],
      },
    ]);
  });

  it('reads a commit refusal as a decision, whatever its type', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: attentionRows(1, { b3Type: 'Venda', classification: 'invalid' }),
      }),
    );

    expect(summary.attention).toEqual([
      {
        kind: 'import_rows',
        batchId: BATCH,
        resolution: 'decide',
        count: 1,
        movements: [{ assetCode: 'PETR4', movement: 'Venda', count: 1 }],
      },
    ]);
  });

  /**
   * The ordinary first-week state: a full extract imported, no wallet created
   * yet, so every held asset is awaiting allocation. At BR-016-01's reference
   * scale that is a hundred rows under the headline, which turns "is there
   * anything for me to do?" into a holdings list and pushes the reconciliation
   * status off the first screenful.
   */
  it('caps the queue and reports the true total rather than truncating silently', async () => {
    const query = await queryFor([{ assetId: PETR }]);
    const pending = Array.from({ length: 40 }, (_, index) => ({
      assetId: assetIdOf(String(index + 10)),
      unassignedQuantity: Quantity.fromString('1'),
      reason: 'no_wallet' as const,
    }));

    const summary = buildDashboardSummary(input({ query, pending }));

    expect(summary.attention).toHaveLength(ATTENTION_QUEUE_LIMIT);
    // The honest count, so the screen can say what it is not showing.
    expect(summary.attentionTotal).toBe(40);
  });

  /**
   * SPEC-020 BR-020-18 — the overflow link goes to `/wallets`, which resolves
   * allocations and nothing else. A gate hidden behind it would have no route
   * to the one screen that fixes it, so gates are never capped.
   */
  it('lists every gate even past the cap, and caps only pending allocations', async () => {
    const query = await queryFor([{ assetId: PETR }]);
    const contractsMissingRate = Array.from({ length: 6 }, (_, index) => ({
      assetId: assetIdOf(String(index + 60)),
      assetCode: `CDB${index}`,
      held: true,
    }));
    const pending = Array.from({ length: 4 }, (_, index) => ({
      assetId: assetIdOf(String(index + 10)),
      unassignedQuantity: Quantity.fromString('1'),
      reason: 'no_wallet' as const,
    }));

    const summary = buildDashboardSummary(input({ query, contractsMissingRate, pending }));

    expect(summary.attention.map((item) => item.kind)).toEqual(
      Array.from({ length: 6 }, () => 'fixed_income_rate'),
    );
    expect(summary.attentionTotal).toBe(10);
  });

  it('never lets the cap push out the items that make the figures wrong', async () => {
    // An unclassified row is excluded from the replay behind every position, so
    // the headline may be wrong; a pending allocation is already inside that
    // total. If the cap could drop the first kind in favour of the second, the
    // ordering above would be decorative.
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        importRows: attentionRows(3),
        pending: Array.from({ length: 20 }, (_, index) => ({
          assetId: assetIdOf(String(index + 10)),
          unassignedQuantity: Quantity.fromString('1'),
          reason: 'no_wallet' as const,
        })),
      }),
    );

    expect(summary.attention[0]).toEqual(THREE_UNMAPPED_ROWS);
    expect(summary.attentionTotal).toBe(21);
  });

  it('reports a total equal to the list when nothing is hidden', async () => {
    const query = await queryFor([{ assetId: PETR }]);

    const summary = buildDashboardSummary(
      input({
        query,
        pending: [
          { assetId: PETR, unassignedQuantity: Quantity.fromString('40'), reason: 'no_wallet' },
        ],
      }),
    );

    expect(summary.attention).toHaveLength(1);
    expect(summary.attentionTotal).toBe(1);
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

// ---------------------------------------------------------------------------
// #233 — month-over-month changes under the headline figures
// ---------------------------------------------------------------------------

function aSnapshot(date: string, total: string, earningsToDate = '0'): DailyValuationSnapshot {
  return {
    date: day(date),
    totalValue: money(total),
    netContributions: money('0'),
    marketFlows: money('0'),
    earningsToDate: money(earningsToDate),
    byAssetClass: new Map([['stock', money(total)]]),
    hasEstimates: false,
  };
}

function aPayment(payDate: string, amount: string): EarningRecord {
  return {
    assetId: PETR,
    institutionId: institutionIdOf('1'),
    type: 'dividend',
    payDate: day(payDate),
    amount: money(amount),
    quantity: qty('100'),
  };
}

describe('the two calendar months (#233)', () => {
  it('is the month to today and the whole month before it', () => {
    expect(dashboardMonths(day('2026-09-12'))).toEqual({
      current: { month: '2026-09', from: day('2026-09-01'), to: day('2026-09-12') },
      previous: { month: '2026-08', from: day('2026-08-01'), to: day('2026-08-31') },
    });
  });

  it('crosses a year boundary in January', () => {
    expect(dashboardMonths(day('2027-01-04')).previous).toEqual({
      month: '2026-12',
      from: day('2026-12-01'),
      to: day('2026-12-31'),
    });
  });

  it('ends a leap February on the 29th', () => {
    expect(dashboardMonths(day('2028-03-01')).previous.to).toBe(day('2028-02-29'));
  });

  it('is a single day on the first of the month', () => {
    expect(dashboardMonths(day('2026-10-01')).current).toEqual({
      month: '2026-10',
      from: day('2026-10-01'),
      to: day('2026-10-01'),
    });
  });
});

describe('patrimônio since the last month-end (#233, SPEC-013 BR-013-02)', () => {
  /**
   * The approved frame's own figures. Hand-computed:
   *   653.491,42 − 639.802,05 = +13.689,37
   *   13.689,37 ÷ 639.802,05 = 0,021396… → "+2,14 %"
   */
  it('is today’s report total against the month-end snapshot', async () => {
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('653491.42'), costBasis: money('1') },
    ]);

    const summary = buildDashboardSummary(
      input({ query, monthEnd: aSnapshot('2026-08-31', '639802.05') }),
    );
    if (summary.portfolio.kind !== 'valued') throw new Error('expected a valued portfolio');
    const since = summary.portfolio.sinceMonthEnd;
    if (since.kind !== 'available') throw new Error('expected a month-end comparison');

    expect(since.asOf).toBe(day('2026-08-31'));
    expect(since.change.toDecimal().toFixed(2)).toBe('13689.37');
    expect(since.ratio?.equals(money('13689.37').dividedBy(money('639802.05').toDecimal()))).toBe(
      true,
    );
    // As the screen rounds it (Intl, half-up): Money itself truncates (AR-09).
    expect(Number(since.ratio?.toString()).toFixed(4)).toBe('0.0214');
  });

  it('dates the comparison by the snapshot, when the month’s last close is earlier', async () => {
    // A gap at the end of August: the last close before September is the 28th.
    // Hand-computed: 1.000 − 1.250 = −250; −250 ÷ 1.250 = −0,2.
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('1') },
    ]);

    const summary = buildDashboardSummary(
      input({ query, monthEnd: aSnapshot('2026-08-28', '1250') }),
    );

    expect(summary.portfolio).toMatchObject({
      sinceMonthEnd: { kind: 'available', asOf: day('2026-08-28') },
    });
    if (summary.portfolio.kind !== 'valued') throw new Error('expected a valued portfolio');
    const since = summary.portfolio.sinceMonthEnd;
    if (since.kind !== 'available') throw new Error('expected a month-end comparison');
    expect(since.change.equals(money('-250'))).toBe(true);
    expect(since.ratio?.equals(money('-0.2'))).toBe(true);
  });

  it('says there is no month-end yet rather than comparing against zero', async () => {
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('1') },
    ]);

    const summary = buildDashboardSummary(input({ query, monthEnd: null }));

    expect(summary.portfolio).toMatchObject({ sinceMonthEnd: { kind: 'none' } });
  });

  it('carries the change but no percentage from a month-end worth nothing', async () => {
    const query = await queryFor([
      { assetId: PETR, quantity: qty('100'), value: money('1000'), costBasis: money('1') },
    ]);

    const summary = buildDashboardSummary(input({ query, monthEnd: aSnapshot('2026-08-31', '0') }));
    if (summary.portfolio.kind !== 'valued') throw new Error('expected a valued portfolio');
    const since = summary.portfolio.sinceMonthEnd;
    if (since.kind !== 'available') throw new Error('expected a month-end comparison');

    expect(since.change.equals(money('1000'))).toBe(true);
    expect(since.ratio).toBeNull();
  });
});

describe('proventos this month (#233, SPEC-014 BR-014-01)', () => {
  /**
   * The approved frame's own figures. Hand-computed:
   *   this month  784,10 + 500,00 = 1.284,10
   *   last month  900,33 + 500,00 = 1.400,33
   *   change      1.284,10 − 1.400,33 = −116,23
   *   ratio       −116,23 ÷ 1.400,33 = −0,083002… → "−8,30 %"
   */
  it('totals this month and compares it with the whole of last month', async () => {
    const query = await queryFor([]);

    const summary = buildDashboardSummary(
      input({
        query,
        earnings: {
          current: [aPayment('2026-09-05', '784.10'), aPayment('2026-09-12', '500.00')],
          previous: [aPayment('2026-08-01', '900.33'), aPayment('2026-08-31', '500.00')],
        },
      }),
    );
    const { earnings } = summary;
    if (earnings.kind !== 'received') throw new Error('expected received proventos');

    expect(earnings.month).toBe('2026-09');
    expect(earnings.from).toBe(day('2026-09-01'));
    expect(earnings.to).toBe(TODAY);
    expect(earnings.previousMonth).toBe('2026-08');
    expect(earnings.amount.toDecimal().toFixed(2)).toBe('1284.10');
    expect(earnings.change.toDecimal().toFixed(2)).toBe('-116.23');
    expect(earnings.ratio?.equals(money('-116.23').dividedBy(money('1400.33').toDecimal()))).toBe(
      true,
    );
    expect(Number(earnings.ratio?.toString()).toFixed(4)).toBe('-0.0830');
  });

  it('says none yet, not R$ 0,00, before the first provento', async () => {
    const summary = buildDashboardSummary(input({ query: await queryFor([]) }));

    expect(summary.earnings).toEqual({
      kind: 'none_yet',
      month: '2026-09',
      from: day('2026-09-01'),
      to: TODAY,
    });
  });

  it('says none yet when the month-end snapshot has received nothing either', async () => {
    const summary = buildDashboardSummary(
      input({ query: await queryFor([]), monthEnd: aSnapshot('2026-08-31', '1000', '0') }),
    );

    expect(summary.earnings.kind).toBe('none_yet');
  });

  it('shows a real zero once proventos were received in an earlier month', async () => {
    // Nothing in August or September, R$ 300,00 before that: the zero is true.
    const summary = buildDashboardSummary(
      input({ query: await queryFor([]), monthEnd: aSnapshot('2026-08-31', '1000', '300') }),
    );
    const { earnings } = summary;
    if (earnings.kind !== 'received') throw new Error('expected received proventos');

    expect(earnings.amount.isZero()).toBe(true);
    expect(earnings.change.isZero()).toBe(true);
    expect(earnings.ratio).toBeNull();
  });

  it('reports a month that paid nothing after one that did as −100 %', async () => {
    const summary = buildDashboardSummary(
      input({
        query: await queryFor([]),
        earnings: { current: [], previous: [aPayment('2026-08-15', '100')] },
      }),
    );
    const { earnings } = summary;
    if (earnings.kind !== 'received') throw new Error('expected received proventos');

    expect(earnings.change.equals(money('-100'))).toBe(true);
    expect(earnings.ratio?.equals(money('-1'))).toBe(true);
  });

  it('gives no percentage against a previous month that paid nothing (BR-014-07)', async () => {
    const summary = buildDashboardSummary(
      input({
        query: await queryFor([]),
        earnings: { current: [aPayment('2026-09-03', '50')], previous: [] },
      }),
    );
    const { earnings } = summary;
    if (earnings.kind !== 'received') throw new Error('expected received proventos');

    expect(earnings.change.equals(money('50'))).toBe(true);
    expect(earnings.ratio).toBeNull();
  });
});
