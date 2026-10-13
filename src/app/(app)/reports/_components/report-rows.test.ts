import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import { ranksOf } from '@/app/(app)/reports/_components/report-rows';

/**
 * SPEC-022 BR-022-18 — a figure is sorted by its rank, ranked on the server with
 * exact decimal comparison. The ranks are what the client sorts by, so these are
 * the cases a lexical or a float comparison would get wrong.
 */
describe('ranksOf', () => {
  it('ranks figures by value, not by how they read as text', () => {
    // As strings "9" > "10" > "100"; as figures it is the other way round.
    const figures = ['9', '100', '10'].map((value) => Money.fromString(value));
    expect(ranksOf(figures)).toEqual([0, 2, 1]);
  });

  it('puts a negative figure below zero', () => {
    const figures = ['0', '-5.50', '3'].map((value) => Money.fromString(value));
    expect(ranksOf(figures)).toEqual([1, 0, 2]);
  });

  it('compares exactly where a float would call two figures equal', () => {
    // 0.1 + 0.2 territory: these differ in the 17th digit and are not the same.
    const figures = ['0.30000000000000004', '0.3'].map((value) => Money.fromString(value));
    expect(ranksOf(figures)).toEqual([1, 0]);
  });

  it('gives a figure that does not exist no rank rather than the lowest one', () => {
    const figures = [Money.fromString('-1'), null, Money.fromString('1'), undefined];
    expect(ranksOf(figures)).toEqual([0, undefined, 1, undefined]);
  });

  it('keeps the input order between equal figures', () => {
    const figures = ['5', '5', '5'].map((value) => Money.fromString(value));
    expect(ranksOf(figures)).toEqual([0, 1, 2]);
  });

  it('ranks an empty column as empty', () => {
    expect(ranksOf([])).toEqual([]);
  });
});
