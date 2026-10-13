import { describe, expect, it } from 'vitest';
import type { Row } from '@tanstack/react-table';
import { collatedSortingFn } from '@/components/patterns/table-sorting';

/** A row that holds one value in the column `c`. */
function rowOf(value: unknown): Row<unknown> {
  return { getValue: () => value } as unknown as Row<unknown>;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => collatedSortingFn(rowOf(a), rowOf(b), 'c'));
}

/**
 * SPEC-022 BR-022-18 — text orders by pt-BR collation. Code points put every
 * accented initial after "Z", so "Água" would close the list.
 */
describe('collatedSortingFn', () => {
  it('puts an accented initial with its letter, not after Z', () => {
    expect(sorted(['Varejo', 'Água e Saneamento', 'Zeta', 'Ética', 'Banco'])).toEqual([
      'Água e Saneamento',
      'Banco',
      'Ética',
      'Varejo',
      'Zeta',
    ]);
  });

  it('ignores case and compares digit runs by value', () => {
    expect(sorted(['PETR10', 'petr3', 'PETR4'])).toEqual(['petr3', 'PETR4', 'PETR10']);
  });

  it('orders numbers by value, as the basic comparison does', () => {
    expect(collatedSortingFn(rowOf(2), rowOf(10), 'c')).toBeLessThan(0);
    expect(collatedSortingFn(rowOf(10), rowOf(2), 'c')).toBeGreaterThan(0);
    expect(collatedSortingFn(rowOf(5), rowOf(5), 'c')).toBe(0);
  });

  it('ties an accent-only difference so a stable sort keeps the input order', () => {
    expect(collatedSortingFn(rowOf('acoes'), rowOf('ações'), 'c')).toBe(0);
  });
});
