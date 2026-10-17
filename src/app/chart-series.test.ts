import { describe, expect, it } from 'vitest';
import { chartTip, concealSeries } from '@/app/chart-series';
import { Money } from '@/core/shared/money';
import { formatCurrency } from '@/i18n/format';

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

describe('chartTip (SPEC-022 BR-022-38)', () => {
  it('carries the exact amount, with centavos, formatted from the decimal', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a float; the decimal is exact.
    const amount = Money.fromString('0.1').plus(Money.fromString('0.2'));
    const tip = chartTip('30/09/2026', { value: amount }, false);

    expect(tip.when).toBe('30/09/2026');
    expect(tip.figures.value).toBe(formatCurrency(amount));
    expect(tip.figures.value).toBe('R$\u00a00,30');
  });

  it('keeps centavos a large amount would lose on the axis', () => {
    const tip = chartTip('30/09/2026', { value: Money.fromString('653491.42') }, false);
    expect(tip.figures.value).toBe('R$\u00a0653.491,42');
  });

  it('gives a gap no figure', () => {
    const tip = chartTip(
      'setembro de 2026',
      { amount: Money.fromString('10'), average: null },
      false,
    );
    expect(tip.figures).toEqual({ amount: 'R$\u00a010,00' });
  });

  it('puts only the placeholder in the page while masked', () => {
    const tip = chartTip('30/09/2026', { value: Money.fromString('653491.42') }, true);
    expect(tip).toEqual({ when: '30/09/2026', figures: { value: 'R$\u00a0••••••' } });
  });
});
