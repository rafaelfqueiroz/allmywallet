import { describe, expect, it } from 'vitest';
import { normalizeDecimalInput } from '@/lib/decimal-input';

describe('normalizeDecimalInput', () => {
  it('passes a canonical literal through untouched', () => {
    expect(normalizeDecimalInput('1234.56')).toBe('1234.56');
    expect(normalizeDecimalInput('-25')).toBe('-25');
    expect(normalizeDecimalInput('0.00000001')).toBe('0.00000001');
  });

  it('reads the pt-BR form a user types', () => {
    expect(normalizeDecimalInput('1.234,56')).toBe('1234.56');
    expect(normalizeDecimalInput('32,15')).toBe('32.15');
    expect(normalizeDecimalInput('1.000.000,00')).toBe('1000000.00');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDecimalInput('  32,15  ')).toBe('32.15');
  });

  it('returns null for an empty or unparseable field rather than throwing', () => {
    expect(normalizeDecimalInput('')).toBeNull();
    expect(normalizeDecimalInput('   ')).toBeNull();
    expect(normalizeDecimalInput('abc')).toBeNull();
    expect(normalizeDecimalInput('1,2,3')).toBeNull();
    expect(normalizeDecimalInput('R$ 32,15')).toBeNull();
  });

  /**
   * The one genuinely ambiguous input. In pt-BR `1.234` is a thousands group,
   * and that reading has to win for a hand-typed field — but a canonical
   * literal produced by a browser's own `type="number"` must not be silently
   * multiplied by a thousand, which is why the canonical test runs first.
   */
  it('reads a bare dot as a decimal point, not a thousands group', () => {
    expect(normalizeDecimalInput('1.234')).toBe('1.234');
  });
});
