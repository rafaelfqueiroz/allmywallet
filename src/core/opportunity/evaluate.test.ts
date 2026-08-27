import { describe, expect, it } from 'vitest';
import { evaluateRule } from '@/core/opportunity/evaluate';
import { aBound, aQuote, aRule, money } from '@/core/opportunity/test-support';

/**
 * SPEC-018 BR-018-11..16 — the pure state comparison.
 *
 * TS-04/TS-05: every expected value is hand-reasoned against the cited
 * business rule, never against `evaluateRule`'s own output.
 */

const TIMING = { sessionOpen: true, cadenceMinutes: 30, now: new Date('2026-03-16T13:00:00Z') };

describe('BR-018-16 — no usable quote reads unknown', () => {
  it('is unknown when no quote has ever been stored', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    expect(evaluateRule(rule, null, TIMING)).toEqual({ state: 'unknown' });
  });

  it('is unknown when the stored quote is stale beyond the cadence, during the session', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    // 31 minutes old against a 30-minute cadence, session open — SPEC-008's
    // isQuoteStale reports this as stale.
    const quote = aQuote({
      price: money('35'),
      fetchedAt: new Date('2026-03-16T12:28:00Z'),
    });
    expect(evaluateRule(rule, quote, TIMING)).toEqual({ state: 'unknown' });
  });

  it('is never carried forward from the last real state — the result names only "unknown"', () => {
    const rule = aRule({
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
      lastState: 'sell',
    });
    expect(evaluateRule(rule, null, TIMING)).toEqual({ state: 'unknown' });
  });

  it('reuses SPEC-008 DL-008-03: outside the session, an old quote is not stale', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    const quote = aQuote({ fetchedAt: new Date('2026-03-13T12:00:00Z') }); // days old
    const outsideSession = { ...TIMING, sessionOpen: false };
    // Friday's price is still the price the whole product shows on a
    // Saturday — same reasoning `pollHeldAsset` relies on.
    const result = evaluateRule(rule, quote, outsideSession);
    expect(result.state).not.toBe('unknown');
  });
});

describe('BR-018-12 — a price exactly on a bound matches that bound', () => {
  it('"below R$ 30 = buy" fires at exactly R$ 30,00', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    const quote = aQuote({ price: money('30') });
    const result = evaluateRule(rule, quote, TIMING);
    expect(result).toEqual({ state: 'buy', matched: 'lower', threshold: money('30'), quote });
  });

  it('the same price under a "below R$ 30 = sell" rule produces sell instead', () => {
    const rule = aRule({ lower: aBound('30', 'sell'), upper: aBound('40', 'buy') });
    const quote = aQuote({ price: money('30') });
    const result = evaluateRule(rule, quote, TIMING);
    expect(result.state).toBe('sell');
    expect(result.state).not.toBe(
      evaluateRule(
        aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') }),
        quote,
        TIMING,
      ).state,
    );
  });

  it('"above R$ 40 = sell" fires at exactly R$ 40,00', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    const quote = aQuote({ price: money('40') });
    const result = evaluateRule(rule, quote, TIMING);
    expect(result).toEqual({ state: 'sell', matched: 'upper', threshold: money('40'), quote });
  });

  it('below the lower bound also matches lower (not just exactly on it)', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    const quote = aQuote({ price: money('10') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('buy');
  });

  it('above the upper bound also matches upper', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: aBound('40', 'sell') });
    const quote = aQuote({ price: money('100') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('sell');
  });
});

describe('BR-018-07/12 — the default state applies strictly between the bounds', () => {
  it('reads the default state just above the lower bound', () => {
    const rule = aRule({
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
      defaultState: 'hold',
    });
    const quote = aQuote({ price: money('30.01') });
    const result = evaluateRule(rule, quote, TIMING);
    expect(result).toEqual({ state: 'hold', matched: 'default', threshold: null, quote });
  });

  it('reads the default state just below the upper bound', () => {
    const rule = aRule({
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
      defaultState: 'hold',
    });
    const quote = aQuote({ price: money('39.99') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('hold');
  });

  it('a non-hold default state is honoured too', () => {
    const rule = aRule({
      lower: aBound('30', 'buy'),
      upper: aBound('40', 'sell'),
      defaultState: 'sell',
    });
    const quote = aQuote({ price: money('35') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('sell');
  });
});

describe('a rule with only one bound set', () => {
  it('reads the default state above a lone lower bound', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: null, defaultState: 'hold' });
    const quote = aQuote({ price: money('1000') });
    const result = evaluateRule(rule, quote, TIMING);
    expect(result).toEqual({ state: 'hold', matched: 'default', threshold: null, quote });
  });

  it('still matches a lone lower bound at the threshold', () => {
    const rule = aRule({ lower: aBound('30', 'buy'), upper: null });
    const quote = aQuote({ price: money('30') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('buy');
  });

  it('reads the default state below a lone upper bound', () => {
    const rule = aRule({ lower: null, upper: aBound('40', 'sell'), defaultState: 'hold' });
    const quote = aQuote({ price: money('1') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('hold');
  });

  it('still matches a lone upper bound at the threshold', () => {
    const rule = aRule({ lower: null, upper: aBound('40', 'sell') });
    const quote = aQuote({ price: money('40') });
    expect(evaluateRule(rule, quote, TIMING).state).toBe('sell');
  });
});
