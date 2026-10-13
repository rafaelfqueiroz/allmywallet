import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { rankKeys, ranksOf } from '@/lib/rank-keys';

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

  it('ranks figures by value, not by how they read as text', () => {
    // As strings "9" > "10" > "100"; as figures it is the other way round.
    const rows = ['9', '100', '10'].map((value) => Money.fromString(value));
    expect(ranksOf(rows, (row) => row)).toEqual([0, 2, 1]);
  });

  it('puts a negative figure below zero', () => {
    const rows = ['0', '-5.50', '3'].map((value) => Money.fromString(value));
    expect(ranksOf(rows, (row) => row)).toEqual([1, 0, 2]);
  });

  it('gives a figure that is undefined, like a null one, no rank rather than the lowest', () => {
    const rows = [Money.fromString('-1'), null, Money.fromString('1'), undefined];
    expect(ranksOf(rows, (row) => row)).toEqual([0, undefined, 1, undefined]);
  });

  it('keeps the input order between equal figures', () => {
    const rows = ['5', '5', '5'].map((value) => Money.fromString(value));
    expect(ranksOf(rows, (row) => row)).toEqual([0, 1, 2]);
  });

  it('ranks an empty column as empty', () => {
    expect(ranksOf([], (row: Money) => row)).toEqual([]);
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
