import { describe, expect, it } from 'vitest';
import {
  consumptionPct,
  crossedAlertThreshold,
  hasOndemandBudget,
  hasScheduledBudget,
  ondemandReserve,
  projectedMonthEndUsage,
  scheduledBudget,
  totalUsed,
} from './budget';

/** SPEC-008 BR-008-19/20/21 — the reserve partition and consumption tracking. */
describe('scheduledBudget / ondemandReserve (BR-008-20)', () => {
  it('splits the monthly quota by the configured reserve percent — 15,000 @ 10% reserve', () => {
    // Hand-computed: 15000 * 90% = 13500 scheduled, 15000 * 10% = 1500 reserved.
    expect(scheduledBudget(15_000, 10)).toBe(13_500);
    expect(ondemandReserve(15_000, 10)).toBe(1_500);
  });

  it('the two halves always sum back to the whole quota, at any percent', () => {
    for (const pct of [0, 1, 7, 10, 33, 99, 100]) {
      expect(scheduledBudget(15_000, pct) + ondemandReserve(15_000, pct)).toBe(15_000);
    }
  });

  it('floors the scheduled share rather than rounding up at the reserve’s expense', () => {
    // 1000 * (100-7)/100 = 930 exactly; a case where truncation would bite:
    expect(scheduledBudget(999, 10)).toBe(899); // 999*0.9 = 899.1 -> floor 899
    expect(ondemandReserve(999, 10)).toBe(100); // 999 - 899
  });
});

describe('hasScheduledBudget / hasOndemandBudget (BR-008-20)', () => {
  it('scheduled polling cannot be starved by on-demand consumption', () => {
    const usage = { scheduled: 5, ondemand: 1_499 }; // reserve nearly exhausted
    expect(hasScheduledBudget(usage, 15_000, 10)).toBe(true);
    expect(hasOndemandBudget(usage, 15_000, 10)).toBe(true);
  });

  it('on-demand spend is capped at the reserve and cannot dip into the scheduled share', () => {
    const usage = { scheduled: 0, ondemand: 1_500 }; // reserve exactly exhausted
    expect(hasOndemandBudget(usage, 15_000, 10)).toBe(false);
    // Scheduled budget is untouched by on-demand usage — still available.
    expect(hasScheduledBudget(usage, 15_000, 10)).toBe(true);
  });

  it('scheduled budget itself runs out independently at its own ceiling', () => {
    const usage = { scheduled: 13_500, ondemand: 0 };
    expect(hasScheduledBudget(usage, 15_000, 10)).toBe(false);
  });
});

describe('consumptionPct / crossedAlertThreshold (BR-008-21)', () => {
  it('computes total consumption as a percent of the whole quota', () => {
    expect(consumptionPct({ scheduled: 6_000, ondemand: 1_500 }, 15_000)).toBeCloseTo(50, 10);
    expect(totalUsed({ scheduled: 6_000, ondemand: 1_500 })).toBe(7_500);
  });

  it('raises at the configured percent, not a fixed one', () => {
    const usage = { scheduled: 10_000, ondemand: 500 }; // 70% exactly
    expect(crossedAlertThreshold(usage, 15_000, 70)).toBe(true);
    expect(crossedAlertThreshold(usage, 15_000, 71)).toBe(false);
  });
});

describe('projectedMonthEndUsage (BR-008-21)', () => {
  it('extrapolates straight-line from consumption so far this month', () => {
    // Hand-computed: 3000 used after 10 of 30 days -> 3000/10*30 = 9000.
    expect(projectedMonthEndUsage(3_000, 10, 30)).toBe(9_000);
  });

  it('rounds the projection up, matching the "degrade before exhausting" bias', () => {
    // 100/3*30 = 1000 exactly -> no rounding ambiguity; use a case that isn't exact.
    expect(projectedMonthEndUsage(100, 3, 31)).toBe(Math.ceil((100 / 3) * 31));
  });

  it('rejects a non-positive day-of-month or days-in-month, which would divide by zero', () => {
    expect(() => projectedMonthEndUsage(100, 0, 30)).toThrow(RangeError);
    expect(() => projectedMonthEndUsage(100, 10, 0)).toThrow(RangeError);
  });
});
