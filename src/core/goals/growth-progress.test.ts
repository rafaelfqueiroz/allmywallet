import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { domainError } from '@/core/shared/domain-error';
import { AssetId, UserId, WalletGoalId, WalletId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { GoalErrorCode } from '@/core/goals/errors';
import type { WalletGoal } from '@/core/goals/goal';
import type { GoalAllocationEvent } from '@/core/goals/ports';
import {
  GrowthUnavailable,
  currentValueSeries,
  firstAllocationDate,
  growthProgress,
  investedSeries,
  sampleDates,
  walletHoldingsOn,
  type GrowthPoint,
} from '@/core/goals/growth-progress';
import { FakeWalletValuationPort } from '@/core/goals/test-support/fake-repositories';

/**
 * SPEC-019 BR-019-09..13 — the growth burn-up.
 *
 * TS-05: every figure below is hand-computed, with the addition written into
 * the test. The arithmetic is deliberately small enough to check on paper,
 * because a burn-up that is wrong by one allocation looks exactly like one
 * that is right.
 */

const USER = UserId.generate();
const WALLET = WalletId.generate();
const OTHER_WALLET = WalletId.generate();
const PETR4 = AssetId.generate();
const HGLG11 = AssetId.generate();
const CDB = AssetId.generate();

function event(
  effectiveOn: string,
  assetId: AssetId,
  quantity: string,
  costBasisAfter: string | null,
  walletId: WalletId = WALLET,
): GoalAllocationEvent {
  return {
    walletId,
    assetId,
    quantity: Quantity.fromString(quantity),
    effectiveOn: BusinessDate.of(effectiveOn),
    costBasisAfter: costBasisAfter === null ? null : Money.fromString(costBasisAfter),
  };
}

function goalOf(overrides: Partial<WalletGoal> = {}): WalletGoal {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: WalletGoalId.generate(),
    userId: USER,
    walletId: WALLET,
    name: 'Meio milhão',
    kind: 'growth',
    amount: Money.fromString('10000'),
    basis: 'invested',
    period: null,
    achievedOn: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function on(series: readonly GrowthPoint[], date: string): GrowthPoint {
  const point = series.find((candidate) => candidate.date === date);
  if (point === undefined) throw new Error(`no point on ${date}`);
  return point;
}

function valueOn(series: readonly GrowthPoint[], date: string): string {
  const point = on(series, date);
  if (point.kind !== 'available') throw new Error(`point on ${date} is unavailable`);
  return point.value.toString();
}

/**
 * The scenario the worked example in `investedSeries` describes.
 *
 *   10/01  PETR4  100 shares, wallet cost 2.500,00
 *   05/02  HGLG11  50 shares, wallet cost 1.500,00
 *   02/03  PETR4  150 shares, wallet cost 4.000,00  (a *state*, not a delta)
 */
const THREE_EVENTS: readonly GoalAllocationEvent[] = [
  event('2026-01-10', PETR4, '100', '2500'),
  event('2026-02-05', HGLG11, '50', '1500'),
  event('2026-03-02', PETR4, '150', '4000'),
];

const AS_OF = BusinessDate.of('2026-03-15');

describe('BR-019-09/11 — the invested line', () => {
  it('sums the latest cost basis per asset, hand-computed at every change', () => {
    const series = investedSeries(THREE_EVENTS, WALLET, AS_OF);

    // 10/01 → 15/03 inclusive is 64 days apart, so 65 daily points.
    expect(series).toHaveLength(65);
    expect(series[0]?.date).toBe('2026-01-10');
    expect(series.at(-1)?.date).toBe('2026-03-15');

    // PETR4 alone.                         2.500,00
    expect(valueOn(series, '2026-01-10')).toBe('2500');
    expect(valueOn(series, '2026-02-04')).toBe('2500');
    // + HGLG11.              2.500,00 + 1.500,00 = 4.000,00
    expect(valueOn(series, '2026-02-05')).toBe('4000');
    expect(valueOn(series, '2026-03-01')).toBe('4000');
    // PETR4's cost becomes 4.000,00 — a state, so the sum is
    //                       4.000,00 + 1.500,00 = 5.500,00,
    // NOT 2.500 + 1.500 + 4.000 = 8.000,00.
    expect(valueOn(series, '2026-03-02')).toBe('5500');
    expect(valueOn(series, '2026-03-15')).toBe('5500');
  });

  it('BR-019-09 — begins at the wallet’s first allocation and not a day earlier', () => {
    const series = investedSeries(THREE_EVENTS, WALLET, AS_OF);
    expect(series.some((point) => point.date < '2026-01-10')).toBe(false);
    expect(firstAllocationDate(THREE_EVENTS, WALLET)).toBe('2026-01-10');
  });

  it('is never marked estimated — a cost basis is recorded, never accrued', () => {
    const series = investedSeries(THREE_EVENTS, WALLET, AS_OF);
    expect(series.every((point) => point.kind === 'available' && !point.estimated)).toBe(true);
  });

  it('a wallet that sold everything reads zero on that date, not unavailable', () => {
    const series = investedSeries(
      [event('2026-01-10', PETR4, '100', '2500'), event('2026-02-05', PETR4, '0', '0')],
      WALLET,
      AS_OF,
    );
    expect(valueOn(series, '2026-02-04')).toBe('2500');
    expect(valueOn(series, '2026-02-05')).toBe('0');
  });

  it('ignores another wallet’s events entirely, including one that precedes its own', () => {
    // The other wallet allocated five days earlier. The line must still begin
    // on 10/01 — the first allocation of *this* wallet.
    const events = [event('2026-01-05', PETR4, '999', '999999', OTHER_WALLET), ...THREE_EVENTS];
    const series = investedSeries(events, WALLET, AS_OF);
    expect(firstAllocationDate(events, WALLET)).toBe('2026-01-10');
    expect(series[0]?.date).toBe('2026-01-10');
    expect(valueOn(series, '2026-03-15')).toBe('5500');
  });

  it('has no line at all for a wallet that never allocated, and for one whose history starts later', () => {
    expect(investedSeries([], WALLET, AS_OF)).toEqual([]);
    expect(firstAllocationDate([], WALLET)).toBeNull();
    expect(investedSeries([event('2026-04-01', PETR4, '10', '100')], WALLET, AS_OF)).toEqual([]);
  });
});

describe('BR-019-13 / DL-019-04 — the growth series is not year-scoped', () => {
  it('crosses a year boundary continuously and does not reset in January', () => {
    const events = [
      event('2025-11-03', PETR4, '10', '1000'),
      event('2026-01-20', HGLG11, '5', '500'),
    ];
    // 2025-11-03 → 2026-02-10 is 99 days apart: daily, 100 points.
    const series = investedSeries(events, WALLET, BusinessDate.of('2026-02-10'));

    expect(series).toHaveLength(100);
    expect(series[0]?.date).toBe('2025-11-03');

    // The line runs straight through the turn of the year unchanged.
    expect(valueOn(series, '2025-12-31')).toBe('1000');
    expect(valueOn(series, '2026-01-01')).toBe('1000');
    // …and keeps accumulating afterwards.  1.000,00 + 500,00 = 1.500,00
    expect(valueOn(series, '2026-01-19')).toBe('1000');
    expect(valueOn(series, '2026-01-20')).toBe('1500');
    expect(valueOn(series, '2026-02-10')).toBe('1500');

    // The two dates are adjacent: no bucket is dropped at the boundary.
    const dates = series.map((point) => point.date);
    expect(dates.indexOf('2026-01-01' as BusinessDate)).toBe(
      dates.indexOf('2025-12-31' as BusinessDate) + 1,
    );
  });
});

describe('BR-019-12 — the current-value line', () => {
  it('differs from the invested line on the same wallet, both hand-computed', async () => {
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');
    valuation.price(HGLG11, '40');

    const valued = await currentValueSeries(valuation, THREE_EVENTS, WALLET, AS_OF);
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;

    // 15/03 market value: PETR4 150 × 30,00 = 4.500,00
    //                   HGLG11  50 × 40,00 = 2.000,00
    //                                        = 6.500,00
    expect(valueOn(valued.value, '2026-03-15')).toBe('6500');
    // …against an invested figure of 5.500,00 on the very same date.
    expect(valueOn(investedSeries(THREE_EVENTS, WALLET, AS_OF), '2026-03-15')).toBe('5500');

    // 04/02, before HGLG11 was allocated: PETR4 100 × 30,00 = 3.000,00
    expect(valueOn(valued.value, '2026-02-04')).toBe('3000');
  });

  it('BR-010-22 — hands the pricer the wallet’s own cost, not the position’s', async () => {
    // The wallet's `cost_basis_after` crosses the seam whole, quantity beside
    // it, and the adapter derives an average from the pair. Sending an average
    // from here would have put the division — and the choice of which cost to
    // divide — in the module furthest from the asset class it depends on.
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');
    valuation.price(HGLG11, '40');
    await currentValueSeries(valuation, THREE_EVENTS, WALLET, AS_OF);

    const last = valuation.seen.at(-1);
    expect(last?.date).toBe('2026-03-15');
    const petr = last?.holdings.find((holding) => holding.assetId === PETR4);
    const hglg = last?.holdings.find((holding) => holding.assetId === HGLG11);
    // The wallet's own accumulated cost after the 02/03 top-up, and its
    // quantity — 4.000,00 over 150 PETR4, never the position's average.
    expect(petr?.costBasisAfter?.toString()).toBe('4000');
    expect(petr?.quantity.toString()).toBe('150');
    expect(hglg?.costBasisAfter?.toString()).toBe('1500');
    expect(hglg?.quantity.toString()).toBe('50');
  });

  it('CR-1 — accrued fixed income rides out to the point and to the report', async () => {
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');
    valuation.price(CDB, '1.05', true);

    const events = [
      event('2026-01-10', PETR4, '100', '2500'),
      event('2026-02-05', CDB, '1000', '1000'),
    ];
    const result = await growthProgress(
      valuation,
      goalOf({ basis: 'current_value' }),
      events,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Before the CDB: 100 × 30,00 = 3.000,00, observed.
    expect(on(result.value.series, '2026-02-04')).toMatchObject({ estimated: false });
    // After it: 3.000,00 + 1.000 × 1,05 = 4.050,00, part accrued.
    expect(valueOn(result.value.series, '2026-02-05')).toBe('4050');
    expect(on(result.value.series, '2026-02-05')).toMatchObject({ estimated: true });
    expect(result.value.estimated).toBe(true);
  });

  it('values an asset the test never priced at zero — the fake stating its own default', async () => {
    // Scaffolding, not a rule. The real adapter routes an unpriceable holding
    // through `valueHoldingsAt`, which flags it `needsAttention` and values it
    // at cost (BR-009-13); this is asserted only so the fake's default cannot
    // drift under a test without the test noticing.
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');

    const valued = await currentValueSeries(valuation, THREE_EVENTS, WALLET, AS_OF);
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;
    // PETR4 150 × 30,00 = 4.500,00; HGLG11 carries no stated price → 0,00.
    expect(valueOn(valued.value, '2026-03-15')).toBe('4500');
  });

  it('propagates a valuation failure rather than drawing a gap', async () => {
    const valuation = new FakeWalletValuationPort();
    valuation.failure = domainError('ASSET_NOT_FOUND', { assetId: PETR4 });

    const result = await currentValueSeries(valuation, THREE_EVENTS, WALLET, AS_OF);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ASSET_NOT_FOUND');

    const progress = await growthProgress(
      valuation,
      goalOf({ basis: 'current_value' }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(progress.ok).toBe(false);
  });
});

describe('BR-019-11 — a cost basis that was never recorded', () => {
  const WITH_NULL: readonly GoalAllocationEvent[] = [
    event('2026-01-10', PETR4, '100', '2500'),
    // Written before the migration that added `cost_basis_after`: `null`.
    event('2026-02-05', HGLG11, '50', null),
  ];

  it('makes the point explicitly unavailable, and never a zero', () => {
    const series = investedSeries(WITH_NULL, WALLET, AS_OF);

    expect(valueOn(series, '2026-02-04')).toBe('2500');
    expect(on(series, '2026-02-05')).toEqual({
      kind: 'unavailable',
      date: '2026-02-05',
      reason: GrowthUnavailable.COST_BASIS_NOT_RECORDED,
    });
    expect(on(series, '2026-03-15').kind).toBe('unavailable');

    // The failure mode this rule exists to prevent: a plausible line at zero,
    // or one understated by exactly the assets whose cost is unknown.
    const values = series
      .filter((point) => point.kind === 'available')
      .map((point) => point.value.toString());
    expect(values).not.toContain('0');
    expect(values.every((value) => value === '2500')).toBe(true);
  });

  it('does NOT stop the current-value line for a listed asset — a market value needs no cost', async () => {
    // The rule that would have been easy to get wrong. HGLG11's cost is
    // unknown, and its market value does not depend on it: quantity × price.
    // Refusing here would make SPEC-019 report no value on a date where
    // SPEC-013's Portfolio Value answers happily for the same wallet, and the
    // two reconciling is an acceptance criterion.
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');
    valuation.price(HGLG11, '40');

    const valued = await currentValueSeries(valuation, WITH_NULL, WALLET, AS_OF);
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;

    // 15/03: PETR4 100 × 30,00 = 3.000,00, HGLG11 50 × 40,00 = 2.000,00.
    expect(valueOn(valued.value, '2026-03-15')).toBe('5000');
    // …while the invested line on the same date has nothing to report.
    expect(on(investedSeries(WITH_NULL, WALLET, AS_OF), '2026-03-15').kind).toBe('unavailable');

    // The undecided `null` crosses the seam rather than being resolved before it.
    const last = valuation.seen.at(-1);
    expect(last?.holdings.find((holding) => holding.assetId === HGLG11)?.costBasisAfter).toBeNull();
  });

  it('DOES stop it for fixed income, which is accrued from the cost basis it lacks', async () => {
    // `core/valuation/accrual.ts` applies the contracted factor to the
    // holding's own cost basis, so with no cost there is nothing to accrue
    // from — a CDB priced at zero would silently drag the whole line down.
    const valuation = new FakeWalletValuationPort();
    valuation.price(PETR4, '30');
    valuation.price(CDB, '1.05', true);

    const events = [
      event('2026-01-10', PETR4, '100', '2500'),
      event('2026-02-05', CDB, '1000', null),
    ];
    const valued = await currentValueSeries(valuation, events, WALLET, AS_OF);
    expect(valued.ok).toBe(true);
    if (!valued.ok) return;

    // Before the CDB joined, the line is drawn: 100 × 30,00 = 3.000,00.
    expect(valueOn(valued.value, '2026-02-04')).toBe('3000');
    expect(on(valued.value, '2026-02-05')).toEqual({
      kind: 'unavailable',
      date: '2026-02-05',
      reason: GrowthUnavailable.COST_BASIS_NOT_RECORDED,
    });
    expect(on(valued.value, '2026-03-15').kind).toBe('unavailable');
  });

  it('leaves the whole progress unavailable rather than reporting a ratio of zero', async () => {
    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('10000') }),
      WITH_NULL,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current?.kind).toBe('unavailable');
    expect(result.value.ratio).toBeNull();
    expect(result.value.achieved).toBe(false);
    expect(result.value.estimated).toBe(false);
  });

  it('a zero-quantity holding with no recorded cost does not poison the point', () => {
    // The wallet no longer holds HGLG11, so its unknown cost is irrelevant —
    // dropping the zero is what keeps the rest of the line drawable.
    const series = investedSeries(
      [event('2026-01-10', PETR4, '100', '2500'), event('2026-02-05', HGLG11, '0', null)],
      WALLET,
      AS_OF,
    );
    expect(valueOn(series, '2026-02-05')).toBe('2500');
    expect(valueOn(series, '2026-03-15')).toBe('2500');
  });
});

describe('BR-019-09 — the sampled dates', () => {
  it('is daily under 180 days, one point per calendar day', () => {
    const dates = sampleDates(
      BusinessDate.of('2026-01-10'),
      BusinessDate.of('2026-03-15'),
      'daily',
    );
    expect(dates).toHaveLength(65);
    expect(dates[0]).toBe('2026-01-10');
    expect(dates[1]).toBe('2026-01-11');
    expect(dates.at(-1)).toBe('2026-03-15');
  });

  it('rolls up to the last day of each ISO week, plus the range’s own end', () => {
    // 2026-01-05 is a Monday; 05/01 → 27/07 is 203 days, past the 180-day
    // weekly threshold. Buckets close on Sundays: 11/01, 18/01, 25/01, …
    const dates = sampleDates(
      BusinessDate.of('2026-01-05'),
      BusinessDate.of('2026-07-27'),
      'weekly',
    );
    expect(dates).toHaveLength(30);
    expect(dates.slice(0, 3)).toEqual(['2026-01-11', '2026-01-18', '2026-01-25']);
    // 26/07 is the last full Sunday; 27/07 is the range's end, kept as its own
    // point so the line ends where the report does.
    expect(dates.slice(-2)).toEqual(['2026-07-26', '2026-07-27']);
  });

  it('rolls up to month ends beyond 730 days — 39 months, leap day included', () => {
    const dates = sampleDates(
      BusinessDate.of('2023-01-15'),
      BusinessDate.of('2026-03-15'),
      'monthly',
    );
    // January 2023 through March 2026 inclusive: 12 + 12 + 12 + 3 = 39.
    expect(dates).toHaveLength(39);
    expect(dates.slice(0, 2)).toEqual(['2023-01-31', '2023-02-28']);
    expect(dates).toContain('2024-02-29');
    expect(dates.at(-1)).toBe('2026-03-15');
  });

  it('produces nothing when the range runs backwards', () => {
    expect(
      sampleDates(BusinessDate.of('2026-03-15'), BusinessDate.of('2026-01-10'), 'daily'),
    ).toEqual([]);
  });

  it('picks the granularity from the wallet’s own span, not from the caller', () => {
    // A wallet allocated in 2023 and read in 2026 spans 1.155 days: monthly.
    const series = investedSeries([event('2023-01-15', PETR4, '10', '1000')], WALLET, AS_OF);
    expect(series).toHaveLength(39);
    expect(series[0]?.date).toBe('2023-01-31');
    expect(series.at(-1)?.date).toBe('2026-03-15');
  });
});

describe('walletHoldingsOn — the fold', () => {
  it('takes the latest event at or before the date, and drops what is no longer held', () => {
    const held = walletHoldingsOn(THREE_EVENTS, WALLET, BusinessDate.of('2026-03-02'));
    expect(held).toHaveLength(2);
    expect(held.find((holding) => holding.assetId === PETR4)?.quantity.toString()).toBe('150');

    const earlier = walletHoldingsOn(THREE_EVENTS, WALLET, BusinessDate.of('2026-01-31'));
    expect(earlier).toHaveLength(1);
    expect(earlier[0]?.quantity.toString()).toBe('100');

    const sold = walletHoldingsOn(
      [...THREE_EVENTS, event('2026-03-10', PETR4, '0', '0')],
      WALLET,
      BusinessDate.of('2026-03-10'),
    );
    expect(sold.map((holding) => holding.assetId)).toEqual([HGLG11]);
  });
});

describe('BR-019-23 — achieved, and the ratio', () => {
  it('reports the ratio as a fraction and is achieved at exactly the amount', async () => {
    const valuation = new FakeWalletValuationPort();

    // 5.500,00 ÷ 10.000,00 = 0,55 — a fraction, never 55.
    const below = await growthProgress(
      valuation,
      goalOf({ amount: Money.fromString('10000') }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.ratio?.toString()).toBe('0.55');
    expect(below.value.achieved).toBe(false);
    expect(below.value.basis).toBe('invested');
    expect(below.value.goalAmount.toString()).toBe('10000');

    // Exactly the amount: BR-019-23 says *reaches or exceeds*.
    const exact = await growthProgress(
      valuation,
      goalOf({ amount: Money.fromString('5500') }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.value.achieved).toBe(true);
    expect(exact.value.ratio?.toString()).toBe('1');

    // One centavo above the figure: not yet.
    const justAbove = await growthProgress(
      valuation,
      goalOf({ amount: Money.fromString('5500.01') }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(justAbove.ok).toBe(true);
    if (!justAbove.ok) return;
    expect(justAbove.value.achieved).toBe(false);
  });

  it('has no ratio and no current point for a wallet with no allocation history', async () => {
    const result = await growthProgress(new FakeWalletValuationPort(), goalOf(), [], AS_OF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.series).toEqual([]);
    expect(result.value.current).toBeNull();
    expect(result.value.ratio).toBeNull();
    expect(result.value.achieved).toBe(false);
  });

  it('refuses to divide by a goal amount of zero', async () => {
    // Unreachable through `createGoal`, which refuses it — but this function is
    // pure and a malformed row must not produce `Infinity%`.
    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.zero() }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ratio).toBeNull();
    // Zero is still *reached* by 5.500,00 — the ratio is undefined, not the
    // comparison.
    expect(result.value.achieved).toBe(true);
  });

  it('refuses a goal of the other kind, and a growth row with no basis', async () => {
    const valuation = new FakeWalletValuationPort();

    const earnings = await growthProgress(
      valuation,
      goalOf({ kind: 'earnings', basis: null, period: 'monthly' }),
      THREE_EVENTS,
      AS_OF,
    );
    expect(earnings.ok).toBe(false);
    if (!earnings.ok) expect(earnings.error.code).toBe(GoalErrorCode.NOT_A_GROWTH_GOAL);

    const malformed = await growthProgress(valuation, goalOf({ basis: null }), THREE_EVENTS, AS_OF);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe(GoalErrorCode.NOT_A_GROWTH_GOAL);
  });
});

describe('BR-019-27 / AC-16 — editing the amount moves only the goal line', () => {
  it('leaves every historical point identical, value for value', async () => {
    const valuation = new FakeWalletValuationPort();
    const before = await growthProgress(
      valuation,
      goalOf({ amount: Money.fromString('10000') }),
      THREE_EVENTS,
      AS_OF,
    );
    const after = await growthProgress(
      valuation,
      goalOf({ amount: Money.fromString('250000') }),
      THREE_EVENTS,
      AS_OF,
    );

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const render = (points: readonly GrowthPoint[]) =>
      points.map((point) =>
        point.kind === 'available'
          ? `${point.date}|${point.value.toString()}|${String(point.estimated)}`
          : `${point.date}|${point.reason}`,
      );

    expect(render(after.value.series)).toEqual(render(before.value.series));
    // Only the goal figure and what is derived from it move.
    expect(after.value.goalAmount.toString()).toBe('250000');
    // 5.500,00 ÷ 250.000,00 = 0,022
    expect(after.value.ratio?.toString()).toBe('0.022');
    expect(before.value.ratio?.toString()).toBe('0.55');
  });
});

describe('TS-11 — precision under three hundred allocations', () => {
  it('sums repeating-tail costs with no drift, and divides to forty digits', async () => {
    // 300 assets, allocated one per day from 2026-01-01. Their wallet costs
    // cycle through 0,10000001 / 0,20000002 / 0,30000003 — a hundred of each:
    //   100 × 0,10000001 = 10,000001
    //   100 × 0,20000002 = 20,000002
    //   100 × 0,30000003 = 30,000003
    //                    = 60,000006
    const costs = ['0.10000001', '0.20000002', '0.30000003'];
    const events: GoalAllocationEvent[] = [];
    for (let index = 0; index < 300; index += 1) {
      const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
      events.push(event(day, AssetId.generate(), '1', costs[index % 3] ?? '0'));
    }

    // Day 300 counting from 01/01 is 27/10/2026 — 299 days, so weekly buckets.
    const asOf = BusinessDate.of('2026-10-27');
    const series = investedSeries(events, WALLET, asOf);
    expect(valueOn(series, '2026-10-27')).toBe('60.000006');

    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('7') }),
      events,
      asOf,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 60,000006 ÷ 7 = 8 + 4,000006 ÷ 7
    //               = 8 + (0,571428571428…  +  0,000000857142857142…)
    //               = 8,571429428571428571…
    // decimal.js keeps 40 significant digits and truncates (ROUND_DOWN), which
    // is 1 + 39 places. A JS `number` carries ~17 — this literal cannot be
    // produced by a float, which is the whole point of TS-11.
    expect(result.value.ratio?.toString()).toBe('8.571429428571428571428571428571428571428');
  });
});

/**
 * BR-019-24 / AC-14 — **the date the goal was achieved, not the date the
 * product looked.**
 *
 * This matters most on the path this product is built around: a user imports
 * four years of B3 extracts in one afternoon and opens the goals page. Every
 * goal their wallet has already met is evaluated for the first time right
 * then — and BR-019-26 makes whatever date gets written permanent.
 */
describe('BR-019-24 — the crossing date', () => {
  it('names the first sampled date that reached the amount, not the last', async () => {
    // 10/01 → 2.500,00; 05/02 → 4.000,00; 02/03 → 5.500,00.
    // A goal of R$ 4.000,00 is met exactly on 05/02 (BR-019-23's inclusive
    // boundary) and stays met afterwards.
    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('4000') }),
      THREE_EVENTS,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBe('2026-02-05');
    expect(result.value.achieved).toBe(true);
  });

  it('keeps the first crossing when the line dips under and crosses again', async () => {
    // 4.000,00 on 05/02, sold down to 1.000,00 on 20/02, back to 6.000,00 on
    // 02/03. A goal of 4.000,00 was achieved in February — BR-019-26 says the
    // marker is not re-earned in March.
    const events = [
      event('2026-01-10', PETR4, '100', '2500'),
      event('2026-02-05', HGLG11, '50', '1500'),
      event('2026-02-20', HGLG11, '0', '0'),
      event('2026-02-20', PETR4, '40', '1000'),
      event('2026-03-02', PETR4, '240', '6000'),
    ];

    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('4000') }),
      events,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBe('2026-02-05');
  });

  it('is null when the line never reached the amount, however long it ran', async () => {
    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('1000000') }),
      THREE_EVENTS,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.achievedOn).toBeNull();
    expect(result.value.achieved).toBe(false);
  });

  it('skips an unavailable point rather than reading it as a crossing', async () => {
    const withNull = [
      event('2026-01-10', PETR4, '100', null),
      event('2026-02-05', HGLG11, '50', '9000'),
    ];
    const result = await growthProgress(
      new FakeWalletValuationPort(),
      goalOf({ amount: Money.fromString('1') }),
      withNull,
      AS_OF,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every point is unavailable — PETR4's cost is unknown throughout — so
    // there is no date, rather than the first date defaulting to one.
    expect(result.value.achievedOn).toBeNull();
  });
});
