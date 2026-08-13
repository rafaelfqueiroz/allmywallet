import { describe, expect, it } from 'vitest';
import { callsPerAssetPerMonth, chooseCadenceMinutes, intradayCallsPerDay } from './cadence';

const SESSION_MINUTES = 420; // 7h session, matches the spec's reference table
const TRADING_DAYS = 21;
const LADDER = [30, 60, 120];

/**
 * SPEC-008 BR-008-22 — hand-verified against the spec's own reference table:
 *
 *   30 min: 14 intraday + 1 close = 15/day * 21 = 315/asset/month, ~42 assets
 *   60 min:  7 intraday + 1 close =  8/day * 21 = 168/asset/month, ~80 assets
 *  120 min:  3 intraday + 1 close =  4/day * 21 =  84/asset/month, ~160 assets
 */
describe('intradayCallsPerDay / callsPerAssetPerMonth (BR-008-22 reference table)', () => {
  it('reproduces the spec table exactly at 30/60/120 minutes', () => {
    expect(intradayCallsPerDay(SESSION_MINUTES, 30)).toBe(14);
    expect(intradayCallsPerDay(SESSION_MINUTES, 60)).toBe(7);
    expect(intradayCallsPerDay(SESSION_MINUTES, 120)).toBe(3);

    expect(callsPerAssetPerMonth(SESSION_MINUTES, 30, TRADING_DAYS)).toBe(315);
    expect(callsPerAssetPerMonth(SESSION_MINUTES, 60, TRADING_DAYS)).toBe(168);
    expect(callsPerAssetPerMonth(SESSION_MINUTES, 120, TRADING_DAYS)).toBe(84);
  });

  it('rejects a non-positive cadence', () => {
    expect(() => intradayCallsPerDay(SESSION_MINUTES, 0)).toThrow(RangeError);
  });
});

describe('chooseCadenceMinutes (BR-008-22)', () => {
  it('stays at 30 minutes for a universe well under the ~42-asset ceiling', () => {
    const scheduledBudget = 13_500; // 15000 @ 10% reserve
    expect(chooseCadenceMinutes(LADDER, 20, scheduledBudget, SESSION_MINUTES, TRADING_DAYS)).toBe(
      30,
    );
  });

  it('degrades to 60 minutes once 30-minute polling would exceed the scheduled budget', () => {
    const scheduledBudget = 13_500;
    // 43 * 315 = 13545 > 13500 -> 30min no longer fits; 43 * 168 = 7224 fits at 60min.
    expect(chooseCadenceMinutes(LADDER, 43, scheduledBudget, SESSION_MINUTES, TRADING_DAYS)).toBe(
      60,
    );
  });

  it('degrades to 120 minutes once 60-minute polling would also exceed the budget', () => {
    const scheduledBudget = 13_500;
    // 81 * 168 = 13608 > 13500 -> 60min no longer fits; 81 * 84 = 6804 fits at 120min.
    expect(chooseCadenceMinutes(LADDER, 81, scheduledBudget, SESSION_MINUTES, TRADING_DAYS)).toBe(
      120,
    );
  });

  it('returns the most conservative rung even if the universe outgrows every rung', () => {
    const scheduledBudget = 13_500;
    expect(
      chooseCadenceMinutes(LADDER, 1_000, scheduledBudget, SESSION_MINUTES, TRADING_DAYS),
    ).toBe(120);
  });

  it('picks the fastest cadence when nothing is held at all', () => {
    expect(chooseCadenceMinutes(LADDER, 0, 13_500, SESSION_MINUTES, TRADING_DAYS)).toBe(30);
  });

  it('rejects an empty ladder', () => {
    expect(() => chooseCadenceMinutes([], 10, 13_500, SESSION_MINUTES, TRADING_DAYS)).toThrow(
      RangeError,
    );
  });
});
