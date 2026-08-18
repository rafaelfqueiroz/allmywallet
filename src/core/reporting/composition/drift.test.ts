import { describe, expect, it } from 'vitest';
import type { AssetClass } from '@/core/quotes/ports';
import { Money } from '@/core/shared/money';
import type { DailyValuationSnapshot, Scope } from '@/core/reporting/ports';
import { HistoryUnavailable, type SnapshotDerived } from '@/core/reporting/snapshot-derived';
import { day, money, qty, walletIdOf } from '@/core/reporting/test-support';
import type { AllocationShift, CompositionSlice } from '@/core/reporting/composition/ports';
import { allocationDrift } from '@/core/reporting/composition/drift';

/**
 * SPEC-015 BR-015-04 — composition drift, and the two absences it refuses to
 * paper over.
 *
 * The refusals carry more weight than the happy path here. Substituting the
 * portfolio's historical allocation for a wallet's produces a chart in which
 * every number is real and the answer is false, and nothing on screen would
 * say so — the failure mode SPEC-012 refused first, SPEC-013 second, and this
 * refuses third.
 */

const PORTFOLIO: Scope = { kind: 'portfolio' };
const WALLET: Scope = { kind: 'wallet', walletId: walletIdOf('1') };

function aSnapshot(
  byAssetClass: readonly (readonly [AssetClass, string])[],
): DailyValuationSnapshot {
  const entries = byAssetClass.map(([assetClass, value]) => [assetClass, money(value)] as const);
  return {
    date: day('2026-01-31'),
    totalValue: entries.reduce((acc, [, value]) => acc.plus(value), Money.zero()),
    netContributions: money('0'),
    earningsToDate: money('0'),
    byAssetClass: new Map(entries),
    hasEstimates: false,
  };
}

function aSlice(assetClass: string, share: string | null): CompositionSlice {
  return {
    key: { dimension: 'asset_class', id: assetClass, synthetic: false },
    totals: {
      value: money('1'),
      costBasis: money('1'),
      quantity: qty('1'),
      estimated: false,
    },
    share: share === null ? null : money(share),
  };
}

function reasonOf(drift: SnapshotDerived<readonly AllocationShift[]>): HistoryUnavailable {
  if (drift.kind === 'available') throw new Error('expected an unavailable drift');
  return drift.reason;
}

function shiftsOf(drift: SnapshotDerived<readonly AllocationShift[]>): readonly AllocationShift[] {
  if (drift.kind === 'unavailable') throw new Error(`expected drift, got ${drift.reason}`);
  return drift.value;
}

describe('allocationDrift — what it refuses, and why', () => {
  it('refuses at wallet scope, naming the snapshot as the reason (ADR-002)', () => {
    /**
     * The dangerous alternative is applying today's wallet split to the
     * portfolio's historical snapshot. It is undetectable: every figure in the
     * result is a true fact about this user, so nothing looks broken, and the
     * only way to find out is to reconcile against a broker statement.
     */
    const drift = allocationDrift({
      opening: aSnapshot([
        ['stock', '800'],
        ['fii', '200'],
      ]),
      closing: [aSlice('stock', '0.5'), aSlice('fii', '0.5')],
      grouping: 'asset_class',
      scope: WALLET,
    });

    expect(reasonOf(drift)).toBe(HistoryUnavailable.WALLET_SCOPE_NOT_SNAPSHOTTED);
  });

  it.each(['wallet', 'asset', 'sector', 'institution'] as const)(
    'refuses to drift by %s — the snapshot decomposes by asset class and nothing else',
    (grouping) => {
      const drift = allocationDrift({
        opening: aSnapshot([['stock', '1000']]),
        closing: [aSlice('anything', '1')],
        grouping,
        scope: PORTFOLIO,
      });

      expect(reasonOf(drift)).toBe(HistoryUnavailable.NO_HISTORICAL_BREAKDOWN);
    },
  );

  it('refuses when no snapshot precedes the period', () => {
    // Always true of the `all` period, whose range opens on the tenant's first
    // snapshot: there is nothing before the beginning.
    const drift = allocationDrift({
      opening: null,
      closing: [aSlice('stock', '1')],
      grouping: 'asset_class',
      scope: PORTFOLIO,
    });

    expect(reasonOf(drift)).toBe(HistoryUnavailable.NO_ALLOCATION_TO_COMPARE);
  });

  it('refuses when the baseline snapshot holds nothing', () => {
    /**
     * The account before it held anything. Assuming an empty baseline instead
     * would report every class as having gone from 0 % to its current share,
     * which reads as a dramatic reallocation and is actually just the account
     * opening.
     */
    const drift = allocationDrift({
      opening: aSnapshot([
        ['stock', '0'],
        ['fii', '0'],
      ]),
      closing: [aSlice('stock', '1')],
      grouping: 'asset_class',
      scope: PORTFOLIO,
    });

    expect(reasonOf(drift)).toBe(HistoryUnavailable.NO_ALLOCATION_TO_COMPARE);
  });

  it('refuses when the scope holds nothing today', () => {
    const drift = allocationDrift({
      opening: aSnapshot([['stock', '1000']]),
      closing: [aSlice('stock', null)],
      grouping: 'asset_class',
      scope: PORTFOLIO,
    });

    expect(reasonOf(drift)).toBe(HistoryUnavailable.NO_ALLOCATION_TO_COMPARE);
  });
});

describe('allocationDrift — BR-015-04: the shift itself', () => {
  it('reports the change in share, not the change in value', () => {
    /**
     * By hand. Baseline: 800 stock + 200 fii = 1.000, so 80 % / 20 %.
     * Today the report says 50 % / 50 %. The shift is therefore −30 points of
     * stock and +30 of fii — and it is *the same shift* whether the portfolio
     * doubled or halved in the meantime, which is the whole reason this rule
     * is about shares.
     */
    const shifts = shiftsOf(
      allocationDrift({
        opening: aSnapshot([
          ['stock', '800'],
          ['fii', '200'],
        ]),
        closing: [aSlice('stock', '0.5'), aSlice('fii', '0.5')],
        grouping: 'asset_class',
        scope: PORTFOLIO,
      }),
    );

    expect(shifts.map((shift) => shift.key.id)).toEqual(['fii', 'stock']);
    expect(shifts.map((shift) => shift.opening.toString())).toEqual(['0.2', '0.8']);
    expect(shifts.map((shift) => shift.closing.toString())).toEqual(['0.5', '0.5']);
    expect(shifts.map((shift) => shift.change.toString())).toEqual(['0.3', '-0.3']);
  });

  it('keeps a class that was sold out of during the period', () => {
    /**
     * Listing only what is held now would hide the single most informative
     * drift there is: the position that left. It shows at 0 % today, against
     * whatever it was at the baseline.
     */
    const shifts = shiftsOf(
      allocationDrift({
        opening: aSnapshot([
          ['stock', '750'],
          ['bdr', '250'],
        ]),
        closing: [aSlice('stock', '1')],
        grouping: 'asset_class',
        scope: PORTFOLIO,
      }),
    );

    const bdr = shifts.find((shift) => shift.key.id === 'bdr');
    expect(bdr?.opening.toString()).toBe('0.25');
    expect(bdr?.closing.toString()).toBe('0');
    expect(bdr?.change.toString()).toBe('-0.25');
  });

  it('reports a class bought into during the period as opening at zero', () => {
    const shifts = shiftsOf(
      allocationDrift({
        opening: aSnapshot([['stock', '1000']]),
        closing: [aSlice('stock', '0.6'), aSlice('etf', '0.4')],
        grouping: 'asset_class',
        scope: PORTFOLIO,
      }),
    );

    const etf = shifts.find((shift) => shift.key.id === 'etf');
    expect(etf?.opening.toString()).toBe('0');
    expect(etf?.change.toString()).toBe('0.4');
  });

  it('takes the closing shares from the report, not from the snapshot', () => {
    /**
     * DL-015-06 / BR-015-10. A snapshot is written by a nightly job and the
     * report is valued live, so the two can differ. Reading the closing end
     * off the snapshot would put a drift table on screen whose "hoje" column
     * disagreed with the chart directly above it — and the chart is the one
     * the user is looking at.
     */
    const shifts = shiftsOf(
      allocationDrift({
        opening: aSnapshot([
          ['stock', '500'],
          ['fii', '500'],
        ]),
        // Nothing here is derivable from the snapshot above.
        closing: [aSlice('stock', '0.9'), aSlice('fii', '0.1')],
        grouping: 'asset_class',
        scope: PORTFOLIO,
      }),
    );

    expect(shifts.find((shift) => shift.key.id === 'stock')?.closing.toString()).toBe('0.9');
  });

  it('marks the asset-class dimension so the UI labels it from the catalogue', () => {
    const shifts = shiftsOf(
      allocationDrift({
        opening: aSnapshot([['cdb', '1000']]),
        closing: [aSlice('cdb', '1')],
        grouping: 'asset_class',
        scope: PORTFOLIO,
      }),
    );

    // BR-011-10 has no "Not classified" bucket on this dimension: every asset
    // in the catalog carries a class, so nothing here is ever synthetic.
    expect(shifts[0]?.key).toEqual({ dimension: 'asset_class', id: 'cdb', synthetic: false });
  });
});
