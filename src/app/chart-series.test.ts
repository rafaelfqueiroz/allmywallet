import { describe, expect, it } from 'vitest';
import { concealSeries } from '@/app/chart-series';

describe('concealSeries (SPEC-022 BR-022-24)', () => {
  const rows = [
    { date: '2026-01-01', value: 40_000, goal: 80_000 },
    { date: '2026-02-01', value: null, goal: 80_000 },
    { date: '2026-03-01', value: -20_000, goal: 80_000 },
  ];

  it('returns the coordinates untouched when masking is off', () => {
    expect(concealSeries(rows, ['value', 'goal'], false)).toEqual(rows);
  });

  it('rescales every money key to 0–100 against the largest magnitude, keeping the shape', () => {
    expect(concealSeries(rows, ['value', 'goal'], true)).toEqual([
      { date: '2026-01-01', value: 50, goal: 100 },
      // A gap stays a gap — never a zero.
      { date: '2026-02-01', value: null, goal: 100 },
      // The sign survives: a loss still plots below zero.
      { date: '2026-03-01', value: -25, goal: 100 },
    ]);
  });

  it('leaves keys it was not given alone', () => {
    const [first] = concealSeries([{ month: '2026-01', amount: 7 }], ['amount'], true);
    expect(first).toEqual({ month: '2026-01', amount: 100 });
  });

  it('does not divide by zero on an all-zero or empty series', () => {
    expect(concealSeries([{ amount: 0 }], ['amount'], true)).toEqual([{ amount: 0 }]);
    expect(concealSeries([], ['amount'], true)).toEqual([]);
  });

  it('puts none of the original amounts in the result', () => {
    const concealed = JSON.stringify(
      concealSeries([{ amount: 12_345.67 }, { amount: 98_765.43 }], ['amount'], true),
    );
    expect(concealed).not.toContain('12345');
    expect(concealed).not.toContain('98765');
  });
});
