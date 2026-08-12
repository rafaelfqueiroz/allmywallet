import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { BusinessDate } from '@/core/shared/clock';
import {
  formatBusinessDate,
  formatCurrency,
  formatDateTime,
  formatPercent,
  formatQuantity,
} from '@/i18n/format';

/**
 * AR-47: `R$ 1.234,56` and `dd/mm/yyyy` are decided once, here. These tests
 * exist because a Brazilian user reading `$1,234.56` or `03/15/2026` has been
 * shown a number they cannot check against their broker.
 *
 * `Intl` separates `R$` from the amount with a non-breaking space, which is
 * correct output and unreadable in a test literal. Normalised, not asserted on.
 */
const NBSP = '\u00a0';
const plain = (value: string): string => value.replaceAll(NBSP, ' ');

describe('formatCurrency', () => {
  it('renders reais with a dot thousands separator and a comma decimal', () => {
    expect(plain(formatCurrency(Money.fromString('1234.56')))).toBe('R$ 1.234,56');
  });

  it('rounds to centavos at display and nowhere else (AR-09)', () => {
    // The stored value keeps all eight decimals; only this last step drops them.
    const stored = Money.fromString('27.406666666');
    expect(plain(formatCurrency(stored))).toBe('R$ 27,41');
    expect(stored.toString()).toBe('27.406666666');
  });

  it('renders a negative amount', () => {
    expect(plain(formatCurrency(Money.fromString('-89.9')))).toBe('-R$ 89,90');
  });

  it('renders zero rather than an empty string', () => {
    expect(plain(formatCurrency(Money.zero()))).toBe('R$ 0,00');
  });

  it('keeps the non-breaking space, so the symbol never wraps away from the amount', () => {
    expect(formatCurrency(Money.fromString('1234.56'))).toContain(NBSP);
  });
});

describe('formatQuantity', () => {
  it('drops trailing zeros on a whole share count', () => {
    expect(formatQuantity(Quantity.fromString('100.00000000'))).toBe('100');
  });

  it('keeps a fractional quota count', () => {
    expect(formatQuantity(Quantity.fromString('12.345'))).toBe('12,345');
  });
});

describe('formatPercent', () => {
  it('takes a fraction, not a percentage', () => {
    // 0.1234 is 12,34% — passing 12.34 here would render 1.234,00%.
    expect(formatPercent(Money.fromString('0.1234'))).toBe('12,34%');
    expect(formatPercent(Quantity.fromString('-0.0525'))).toBe('-5,25%');
  });
});

describe('formatBusinessDate', () => {
  it('renders dd/mm/yyyy, not the ISO form', () => {
    expect(formatBusinessDate(BusinessDate.of('2026-03-15'))).toBe('15/03/2026');
  });

  it('does not shift the date across a timezone', () => {
    // A business date carries no time and no zone, so formatting is pure string
    // work — this is the whole reason AR-29 makes it a distinct type.
    expect(formatBusinessDate(BusinessDate.of('2026-01-01'))).toBe('01/01/2026');
    expect(formatBusinessDate(BusinessDate.of('2026-12-31'))).toBe('31/12/2026');
  });
});

describe('formatDateTime', () => {
  it('renders an instant in São Paulo time', () => {
    // 2026-03-16T13:30Z is 10:30 in São Paulo.
    expect(formatDateTime(new Date('2026-03-16T13:30:00Z'))).toContain('10:30');
    expect(formatDateTime(new Date('2026-03-16T13:30:00Z'))).toContain('16/03/2026');
  });
});
