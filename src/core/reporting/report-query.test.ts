import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import { runReportQuery } from '@/core/reporting/base-query';
import {
  ReportingErrorCode,
  UNASSIGNED_GROUP_ID,
  type DailyValuationSnapshot,
} from '@/core/reporting/ports';
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

/**
 * SPEC-011 BR-011-05/13/16 — the shared query the four reports run.
 *
 * TS-01/TS-02: no database. The port is a hand-written fake implementing the
 * real interface, so when `ReportDataPort` changes this stops compiling.
 */

const TODAY = day('2026-08-14');
const itsa = assetIdOf('1');
const cdb = assetIdOf('2');
const walletA = walletIdOf('1');
const walletB = walletIdOf('2');

const snapshot = (date: string, total: string): DailyValuationSnapshot => ({
  date: day(date),
  totalValue: money(total),
  netContributions: money('0'),
  earningsToDate: money('0'),
  byAssetClass: new Map([['stock', money(total)]]),
  hasEstimates: false,
});

function fixture(): FakeReportData {
  return {
    positions: [
      aPosition({
        assetId: itsa,
        institutionId: institutionIdOf('1'),
        quantity: qty('100'),
        value: money('1000'),
        costBasis: money('800'),
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
    allocations: [{ walletId: walletA, assetId: itsa, quantity: qty('60') }],
    wallets: [
      { walletId: walletA, name: 'Aposentadoria' },
      { walletId: walletB, name: 'Reserva' },
    ],
    institutions: [{ institutionId: institutionIdOf('1'), name: 'XP' }],
    assets: [
      anAsset({ assetId: itsa, code: 'ITSA4', assetClass: 'stock', sector: 'Bancos' }),
      anAsset({ assetId: cdb, code: 'CDB-X', assetClass: 'cdb', sector: null }),
    ],
    snapshots: [snapshot('2026-01-05', '900'), snapshot('2026-08-14', '1500')],
  };
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

describe('runReportQuery — BR-011-05, the three controls composed', () => {
  it('resolves period, scope and grouping together at portfolio scope', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'ytd' },
          scope: { kind: 'portfolio' },
          grouping: 'asset_class',
          today: TODAY,
        },
        day('2019-01-01'),
      ),
    );

    expect(result.range).toEqual({ from: '2026-01-01', to: '2026-08-14' });
    expect(result.asOf).toBe('2026-08-14');
    expect(result.scope.wallet).toBeNull();
    // 1000 (ITSA4) + 500 (CDB) = 1500.
    expect(result.report.total.value.toString()).toBe('1500');
    expect(result.report.groups.map((g) => g.key.id)).toEqual(['cdb', 'stock']);
    expect(result.empty).toBe(false);
  });

  it('values holdings at the range end, not at today, for a historical period', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'custom', from: day('2025-01-01'), to: day('2025-06-30') },
          scope: { kind: 'portfolio' },
          grouping: 'asset',
          today: TODAY,
        },
        null,
      ),
    );
    expect(result.asOf).toBe('2025-06-30');
    expect(port.calls).toContain('listValuedPositions:2025-06-30');
  });

  it('clamps the valuation date to today when a custom range ends in the future', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'custom', from: day('2026-01-01'), to: day('2026-12-31') },
          scope: { kind: 'portfolio' },
          grouping: 'asset',
          today: TODAY,
        },
        null,
      ),
    );
    // The requested range is preserved as typed; only the as-of date moves.
    expect(result.range.to).toBe('2026-12-31');
    expect(result.asOf).toBe('2026-08-14');
  });

  it('anchors the all-time period on the earliest snapshot date', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        { period: { kind: 'all' }, scope: { kind: 'portfolio' }, grouping: 'asset', today: TODAY },
        day('2019-03-07'),
      ),
    );
    expect(result.range).toEqual({ from: '2019-03-07', to: '2026-08-14' });
  });
});

describe('BR-011-13 / TS-32 — the query reads caches, never the ledger', () => {
  it('touches only the snapshot, position, allocation and catalog reads', async () => {
    const port = new FakeReportDataPort(fixture());
    await runReportQuery(
      port,
      { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'wallet', today: TODAY },
      null,
    );
    // The port has no method that could reach a transaction, so this is a
    // structural guarantee rather than a convention. Asserting the call set
    // makes a future addition of a ledger read visible here too.
    expect(port.calls.some((call) => call.startsWith('listValuedPositions:'))).toBe(true);
    expect(port.calls).toContain('listAllocations');
    expect(port.calls.some((call) => call.startsWith('listSnapshots:'))).toBe(true);
    expect(port.calls.some((call) => /transaction|ledger/i.test(call))).toBe(false);
  });

  it('returns the persisted snapshot series covering the period', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'asset', today: TODAY },
        null,
      ),
    );
    // Both fixture snapshots fall inside 2026-01-01..2026-08-14.
    expect(result.snapshots.map((s) => s.date)).toEqual(['2026-01-05', '2026-08-14']);
    expect(port.calls).toContain('listSnapshots:2026-01-01:2026-08-14');
  });

  it('excludes snapshots outside the resolved range', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'custom', from: day('2026-02-01'), to: day('2026-03-01') },
          scope: { kind: 'portfolio' },
          grouping: 'asset',
          today: TODAY,
        },
        null,
      ),
    );
    expect(result.snapshots).toEqual([]);
  });

  it("agrees with the snapshot's own total — TS-12's cross-report invariant", async () => {
    // AC-16/TS-12: the Composition total must equal the Portfolio Value
    // endpoint. The fixture's final snapshot says 1500 and the holdings sum
    // to 1500; a framework that disagreed with the snapshot it was reading
    // would put two different numbers for the same day on two screens.
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'sector', today: TODAY },
        null,
      ),
    );
    const endpoint = result.snapshots.at(-1)!.totalValue;
    expect(result.report.total.value.equals(endpoint)).toBe(true);
    expect(endpoint.equals(Money.fromString('1500'))).toBe(true);
  });
});

describe('BR-011-02 — wallet scope', () => {
  it('includes only the wallet allocated slice and names the wallet', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'ytd' },
          scope: { kind: 'wallet', walletId: walletA },
          grouping: 'asset',
          today: TODAY,
        },
        null,
      ),
    );
    expect(result.scope.wallet?.name).toBe('Aposentadoria');
    // 60 of 100 ITSA4 → 1000 × 60/100 = 600. The CDB is unallocated and out.
    expect(result.report.total.value.toString()).toBe('600');
    expect(result.report.groups).toHaveLength(1);
  });

  it('renders an empty state for a wallet holding nothing (BR-011-16 / AC-14)', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'ytd' },
          scope: { kind: 'wallet', walletId: walletB },
          grouping: 'asset',
          today: TODAY,
        },
        null,
      ),
    );
    expect(result.empty).toBe(true);
    expect(result.report.groups).toEqual([]);
    // The total is zero, but `empty` is what the UI branches on — a zero alone
    // cannot distinguish "nothing here yet" from "worth nothing today".
    expect(result.report.total.value.toString()).toBe('0');
  });

  it('refuses a wallet the tenant does not have', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = await runReportQuery(
      port,
      {
        period: { kind: 'ytd' },
        scope: { kind: 'wallet', walletId: walletIdOf('9') },
        grouping: 'asset',
        today: TODAY,
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.WALLET_NOT_FOUND);
  });

  it('validates the scope before computing any figure', async () => {
    // A bookmark naming a deleted wallet must fail before the position cache
    // is read, not after — otherwise the failure costs a full query first.
    const port = new FakeReportDataPort(fixture());
    await runReportQuery(
      port,
      {
        period: { kind: 'ytd' },
        scope: { kind: 'wallet', walletId: walletIdOf('9') },
        grouping: 'asset',
        today: TODAY,
      },
      null,
    );
    expect(port.calls.some((call) => call.startsWith('listValuedPositions'))).toBe(false);
  });
});

describe('BR-011-08/09/10 through the whole query', () => {
  it('shows Unassigned when grouping by wallet at portfolio scope, and reconciles', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'wallet', today: TODAY },
        null,
      ),
    );
    const groups = result.report.groups;
    expect(groups.map((g) => g.key.id)).toEqual([walletA, UNASSIGNED_GROUP_ID]);
    // Wallet A holds 600 of ITSA4; Unassigned holds the other 400 plus the
    // whole 500 CDB = 900. 600 + 900 = 1500.
    expect(groups[0]!.totals.value.toString()).toBe('600');
    expect(groups[1]!.totals.value.toString()).toBe('900');
    expect(result.report.total.value.toString()).toBe('1500');
  });

  it('shows Not classified under sector grouping and still totals 1500', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = unwrap(
      await runReportQuery(
        port,
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'sector', today: TODAY },
        null,
      ),
    );
    // The CDB has no sector — it must appear, not vanish.
    const notClassified = result.report.groups.find((g) => g.key.synthetic)!;
    expect(notClassified.totals.value.toString()).toBe('500');
    expect(result.report.total.value.toString()).toBe('1500');
  });

  it('propagates an invalid period rather than rendering a default range', async () => {
    const port = new FakeReportDataPort(fixture());
    const result = await runReportQuery(
      port,
      {
        period: { kind: 'custom', from: day('2026-06-01'), to: day('2026-01-01') },
        scope: { kind: 'portfolio' },
        grouping: 'asset',
        today: TODAY,
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.INVALID_PERIOD_RANGE);
  });

  it('propagates a catalog gap rather than reporting a smaller portfolio', async () => {
    const data = fixture();
    const port = new FakeReportDataPort({ ...data, assets: [data.assets[0]!] });
    const result = await runReportQuery(
      port,
      { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'asset', today: TODAY },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe(ReportingErrorCode.ASSET_NOT_DESCRIBED);
  });

  it('reports an empty portfolio as empty rather than as zero', async () => {
    const port = new FakeReportDataPort({
      positions: [],
      allocations: [],
      wallets: [],
      institutions: [],
      assets: [],
      snapshots: [],
    });
    const result = unwrap(
      await runReportQuery(
        port,
        {
          period: { kind: 'all' },
          scope: { kind: 'portfolio' },
          grouping: 'asset_class',
          today: TODAY,
        },
        null,
      ),
    );
    expect(result.empty).toBe(true);
    expect(result.range).toEqual({ from: '2026-08-14', to: '2026-08-14' });
  });

  it('finds a wallet through the port and reports institutions for labelling', async () => {
    const port = new FakeReportDataPort(fixture());
    expect(await port.findWallet(walletA)).toEqual({ walletId: walletA, name: 'Aposentadoria' });
    expect(await port.findWallet(walletIdOf('9'))).toBeNull();
    expect(await port.listWallets()).toHaveLength(2);
    expect(await port.listInstitutions()).toEqual([
      { institutionId: institutionIdOf('1'), name: 'XP' },
    ]);
  });
});
