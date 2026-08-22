import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import type { AssetId, WalletId } from '@/core/shared/ids';
import { runReportQuery, type ReportQueryResult } from '@/core/reporting/base-query';
import type {
  AllocationEvent,
  EarningRecord,
  EarningType,
  Grouping,
  Scope,
} from '@/core/reporting/ports';
import { buildEarningsReport } from '@/core/reporting/earnings/report';
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
} from '@/core/reporting/test-support';

/**
 * SPEC-014 — the report, assembled.
 *
 * The pieces are proven in their own files; this asserts what only the
 * assembly can be wrong about: that the scope filter uses the attribution
 * rather than today's allocations, that the breakdown groups through the
 * framework's own resolver, and that the shares and totals reconcile.
 */

const PETR = assetIdOf('1');
const CDB = assetIdOf('2');
const RETIREMENT = walletIdOf('1');
const RESERVE = walletIdOf('2');
const TODAY = day('2026-08-14');

const earning = (
  assetId: AssetId,
  amount: string,
  payDate: string,
  options: { type?: EarningType; quantity?: string } = {},
): EarningRecord => ({
  assetId,
  institutionId: institutionIdOf('1'),
  type: options.type ?? 'dividend',
  payDate: day(payDate),
  amount: money(amount),
  quantity: qty(options.quantity ?? '100'),
});

const allocated = (
  walletId: WalletId,
  assetId: AssetId,
  quantity: string,
  effectiveOn: string,
): AllocationEvent => ({
  walletId,
  assetId,
  quantity: qty(quantity),
  effectiveOn: day(effectiveOn),
});

const DESCRIPTORS = [
  anAsset({ assetId: PETR, code: 'PETR4', assetClass: 'stock', sector: 'Petróleo e Gás' }),
  anAsset({ assetId: CDB, code: 'CDB-X', assetClass: 'cdb', sector: null }),
];

async function query(scope: Scope, grouping: Grouping): Promise<ReportQueryResult> {
  const port = new FakeReportDataPort({
    positions: [
      aPosition({
        assetId: PETR,
        institutionId: institutionIdOf('1'),
        quantity: qty('100'),
        value: money('4000'),
        costBasis: money('1000'),
      }),
      aPosition({
        assetId: CDB,
        institutionId: null,
        quantity: qty('1'),
        value: money('500'),
        costBasis: money('450'),
        estimated: true,
      }),
    ],
    allocations: [{ walletId: RETIREMENT, assetId: PETR, quantity: qty('60') }],
    wallets: [
      { walletId: RETIREMENT, name: 'Aposentadoria' },
      { walletId: RESERVE, name: 'Reserva' },
    ],
    institutions: [{ institutionId: institutionIdOf('1'), name: 'XP' }],
    assets: DESCRIPTORS,
    snapshots: [],
  });

  const result = await runReportQuery(
    port,
    { period: { kind: 'ytd' }, scope, grouping, today: TODAY },
    day('2024-01-01'),
  );
  if (!result.ok) throw new Error(`query failed: ${result.error.code}`);
  return result.value;
}

function build(
  result: ReportQueryResult,
  earnings: readonly EarningRecord[],
  events: readonly AllocationEvent[] = [],
  extra: { trailing?: readonly EarningRecord[]; previous?: readonly EarningRecord[] } = {},
) {
  return buildEarningsReport({
    query: result,
    earnings,
    trailing: extra.trailing ?? earnings,
    previous: extra.previous ?? [],
    allocationEvents: events,
    descriptors: DESCRIPTORS,
  });
}

describe('buildEarningsReport — portfolio scope', () => {
  it('totals the period and breaks it out by type', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), [
      earning(PETR, '80', '2026-03-10'),
      earning(PETR, '40', '2026-06-10', { type: 'jcp' }),
      earning(CDB, '30', '2026-04-10', { type: 'rendimento', quantity: '1' }),
    ]);

    expect(report.total.toString()).toBe('150');
    expect(report.byType.find((total) => total.type === 'jcp')?.amount.toString()).toBe('40');
    expect(report.empty).toBe(false);
  });

  it('breaks income down by the selected grouping, with shares that sum to one', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), [
      earning(PETR, '90', '2026-03-10'),
      earning(CDB, '30', '2026-04-10', { type: 'rendimento', quantity: '1' }),
    ]);

    expect(report.breakdown.map((slice) => [slice.key.id, slice.amount.toString()])).toEqual([
      ['cdb', '30'],
      ['stock', '90'],
    ]);
    const shares = report.breakdown.reduce(
      (acc, slice) => acc.plus(slice.share ?? Money.zero()),
      Money.zero(),
    );
    expect(shares.toString()).toBe('1');
  });

  /**
   * BR-011-10 through the framework's own resolver — the CDB has no sector,
   * and its income appears in "Not classified" rather than vanishing from a
   * sector view that would then disagree with every other view.
   */
  it('files income with no sector under Not classified', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'sector'), [
      earning(CDB, '30', '2026-04-10', { type: 'rendimento', quantity: '1' }),
    ]);

    expect(report.breakdown[0]?.key.synthetic).toBe(true);
    expect(report.breakdown[0]?.amount.toString()).toBe('30');
  });

  it('files unattributed income under Unassigned when grouping by wallet', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'wallet'), [
      earning(PETR, '100', '2026-03-10'),
    ]);

    expect(report.breakdown).toHaveLength(1);
    expect(report.breakdown[0]?.key.synthetic).toBe(true);
  });

  it('splits one payment across the wallets that held it, and the shares still sum', async () => {
    const report = build(
      await query({ kind: 'portfolio' }, 'wallet'),
      [earning(PETR, '100', '2026-03-10')],
      [allocated(RETIREMENT, PETR, '60', '2025-01-01')],
    );

    const byWallet = report.breakdown.map((slice) => [slice.key.id, slice.amount.toString()]);
    expect(byWallet).toContainEqual([RETIREMENT, '60']);
    // BR-011-09: the 40 shares no wallet claimed are visible, not dropped.
    expect(byWallet.some(([id]) => id === '__unassigned__')).toBe(true);
    expect(report.total.toString()).toBe('100');
  });

  it('reports the scope’s yield on cost over every holding', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), [
      earning(PETR, '145', '2026-03-10'),
    ]);

    // 145 ÷ (1.000 + 450) = 10 %.
    expect(report.yieldOnCost?.toString()).toBe('0.1');
  });

  it('compares the period against the one before it', async () => {
    const report = build(
      await query({ kind: 'portfolio' }, 'asset_class'),
      [earning(PETR, '120', '2026-03-10')],
      [],
      { previous: [earning(PETR, '100', '2025-03-10')] },
    );

    expect(report.growth.change?.toString()).toBe('0.2');
  });

  /**
   * BR-014-09/10 — the section is present and says why it is empty. An empty
   * list would read as "you have no upcoming income", which is a claim this
   * product has no source for (PRD Q8, DL-014-06).
   */
  it('states that upcoming income is unavailable rather than showing none', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), []);
    expect(report.upcoming).toEqual({
      kind: 'unavailable',
      reason: 'NO_FORWARD_LOOKING_SOURCE',
    });
  });

  /**
   * The catalog has a row for every asset a transaction references, so this
   * should not happen — and if it ever does, the income still has to reach the
   * total. Losing a payment because its asset could not be named would be a
   * wrong figure hidden behind a missing label.
   */
  it('keeps income for an asset nothing described, under its id', async () => {
    const result = await query({ kind: 'portfolio' }, 'asset');
    const orphan = assetIdOf('9');
    const report = buildEarningsReport({
      query: result,
      earnings: [earning(orphan, '25', '2026-03-10')],
      trailing: [],
      previous: [],
      allocationEvents: [],
      descriptors: DESCRIPTORS,
    });

    expect(report.total.toString()).toBe('25');
    expect(report.breakdown[0]?.key.id).toBe(orphan);
    expect(report.perAsset[0]?.assetCode).toBe(orphan);
  });

  /**
   * A provento recorded at zero — a correction, or an amortization that netted
   * to nothing. There is no denominator, so there is no share: reporting 0 %
   * would be a claim about proportion where none exists.
   */
  it('declines a share when the period’s income totals nothing', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), [
      earning(PETR, '0', '2026-03-10'),
    ]);

    expect(report.breakdown).toHaveLength(1);
    expect(report.breakdown[0]?.share).toBeNull();
  });

  it('reports a period with no income as empty, not as zeroes', async () => {
    const report = build(await query({ kind: 'portfolio' }, 'asset_class'), []);
    expect(report.empty).toBe(true);
    expect(report.total.toString()).toBe('0');
    expect(report.breakdown).toEqual([]);
    // A share of zero out of zero is not 0 %, it is nothing to report.
    expect(report.perAsset).toEqual([]);
  });
});

describe('buildEarningsReport — wallet scope (BR-014-12, Marina’s question)', () => {
  /**
   * **The report's reason to exist.** A holding sat in Reserva until June and
   * in Aposentadoria after it. Scoped to Aposentadoria, only the August
   * payment is its income — and that stays true no matter how the wallets are
   * rearranged tomorrow.
   */
  it('counts only the income the wallet held at the time of each payment', async () => {
    const events = [
      allocated(RESERVE, PETR, '100', '2026-01-01'),
      allocated(RESERVE, PETR, '0', '2026-06-15'),
      allocated(RETIREMENT, PETR, '100', '2026-06-15'),
    ];
    const earnings = [earning(PETR, '80', '2026-04-10'), earning(PETR, '90', '2026-07-10')];

    const retirement = build(
      await query({ kind: 'wallet', walletId: RETIREMENT }, 'asset'),
      earnings,
      events,
    );
    const reserve = build(
      await query({ kind: 'wallet', walletId: RESERVE }, 'asset'),
      earnings,
      events,
    );

    expect(retirement.total.toString()).toBe('90');
    expect(reserve.total.toString()).toBe('80');
    // And together they are the portfolio's income — nothing lost, nothing
    // double-counted by the reassignment.
    expect(retirement.total.plus(reserve.total).toString()).toBe('170');
  });

  it('scopes the growth comparison to the same wallet', async () => {
    const events = [allocated(RETIREMENT, PETR, '100', '2025-01-01')];
    const report = build(
      await query({ kind: 'wallet', walletId: RETIREMENT }, 'asset'),
      [earning(PETR, '120', '2026-03-10')],
      events,
      { previous: [earning(PETR, '100', '2025-03-10')] },
    );

    expect(report.growth.previous.toString()).toBe('100');
    expect(report.growth.change?.toString()).toBe('0.2');
  });

  it('reports a wallet that held nothing when the payments landed as empty', async () => {
    const report = build(
      await query({ kind: 'wallet', walletId: RESERVE }, 'asset'),
      [earning(PETR, '80', '2026-04-10')],
      [allocated(RETIREMENT, PETR, '100', '2026-01-01')],
    );

    expect(report.empty).toBe(true);
    expect(report.total.toString()).toBe('0');
  });
});
