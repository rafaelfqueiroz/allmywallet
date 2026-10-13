import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { rankKeys, ranksOf } from '@/app/(app)/portfolio/_components/ranks';

/**
 * SPEC-022 BR-022-18 — the rank is what lets a Client Component sort a column of
 * amounts it never receives as numbers (AR-06–AR-10).
 */
describe('ranksOf', () => {
  it('ranks by the exact figure, so R$ 1.000,00 comes after R$ 90,00 — not before, as text would', () => {
    const figures = ['1000.00', '90.00', '12.50'].map((value) => Money.fromString(value));
    expect(ranksOf(figures, (figure) => figure)).toEqual([2, 1, 0]);
  });

  it('gives a row with no figure no rank, and does not let it displace the others', () => {
    const rows = [Money.fromString('5'), null, Money.fromString('-3')];
    expect(ranksOf(rows, (row) => row)).toEqual([1, undefined, 0]);
  });

  it('keeps ties in their input order', () => {
    const rows = ['2', '1', '2', '1'].map((value) => Quantity.fromString(value));
    expect(ranksOf(rows, (row) => row)).toEqual([2, 0, 3, 1]);
  });

  it('compares past what a float can hold', () => {
    const rows = ['0.10000000000000001', '0.1'].map((value) => Money.fromString(value));
    // A float reads the two as equal; the decimals differ, so the order is real.
    expect(ranksOf(rows, (row) => row)).toEqual([1, 0]);
  });
});

describe('rankKeys', () => {
  it('collects a row’s rank in each column, leaving out the columns where it has none', () => {
    const columns = { value: [0, 1], gap: [undefined, 0] };
    expect(rankKeys(columns, 0)).toEqual({ value: 0 });
    expect(rankKeys(columns, 1)).toEqual({ value: 1, gap: 0 });
  });
});
