import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { Money } from '@/core/shared/money';
import type { ValuePoint } from '@/core/reporting/portfolio-value/ports';
import { basisOf, toValueChartPoints } from './value-series';

/**
 * SPEC-021 BR-021-31 — a gap day is shown as a gap on the chart and labelled
 * as one in the table; its carried-forward figure is never presented as
 * observed or bridged by the line.
 */
const point = (date: string, value: string, estimated = false): ValuePoint => ({
  date: BusinessDate.of(date),
  value: Money.fromString(value),
  estimated,
});

// Thu 12 observed, Fri 13 a gap (carried forward 3.510,00), Mon 16 estimated.
const SERIES = [
  point('2026-03-12', '3720.00'),
  point('2026-03-13', '3510.00'),
  point('2026-03-16', '3865.00', true),
];
const GAPS: ReadonlySet<string> = new Set(['2026-03-13']);

describe('toValueChartPoints', () => {
  it('plots a gap day as null — a break — and every other day at its value', () => {
    expect(toValueChartPoints(SERIES, GAPS)).toEqual([
      { date: '2026-03-12', value: 3720, estimated: false, gap: false },
      { date: '2026-03-13', value: null, estimated: false, gap: true },
      { date: '2026-03-16', value: 3865, estimated: true, gap: false },
    ]);
  });

  it('with no gaps, nothing is nulled', () => {
    expect(toValueChartPoints(SERIES, new Set()).map((p) => p.value)).toEqual([3720, 3510, 3865]);
  });
});

describe('basisOf', () => {
  it('labels a gap day as a gap, never as observed', () => {
    expect(SERIES.map((p) => basisOf(p, GAPS))).toEqual(['observed', 'gap', 'estimated']);
  });

  it('a gap outranks estimated on the same day', () => {
    expect(basisOf(point('2026-03-13', '3510', true), GAPS)).toBe('gap');
  });
});
