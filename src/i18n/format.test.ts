import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { BusinessDate } from '@/core/shared/clock';
import {
  formatAxisCurrency,
  formatAxisDayMonth,
  formatAxisMonth,
  formatAxisMonthYear,
  formatAxisPercentPoints,
  formatBusinessDate,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatMonth,
  formatMonthName,
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

describe('formatAxisCurrency (SPEC-022 BR-022-38)', () => {
  it('reads whole reais below one thousand', () => {
    expect(plain(formatAxisCurrency(500))).toBe('R$ 500');
    expect(plain(formatAxisCurrency(0))).toBe('R$ 0');
    expect(plain(formatAxisCurrency(999.4))).toBe('R$ 999');
  });

  it('abbreviates thousands and millions with at most one decimal', () => {
    expect(plain(formatAxisCurrency(1_500))).toBe('R$ 1,5 mil');
    expect(plain(formatAxisCurrency(250_000))).toBe('R$ 250 mil');
    expect(plain(formatAxisCurrency(1_234_567))).toBe('R$ 1,2 mi');
  });

  it('marks a withdrawal below the axis as negative', () => {
    expect(plain(formatAxisCurrency(-1_500))).toBe('-R$ 1,5 mil');
  });

  it('keeps the non-breaking space after the symbol', () => {
    expect(formatAxisCurrency(250_000)).toContain(NBSP);
  });
});

describe('formatAxisPercentPoints', () => {
  it('reads percentage points with a comma decimal', () => {
    expect(formatAxisPercentPoints(4.5)).toBe('4,5%');
    expect(formatAxisPercentPoints(-2)).toBe('-2%');
    expect(formatAxisPercentPoints(0)).toBe('0%');
  });
});

describe('formatMonth', () => {
  it('names the month and the year in pt-BR', () => {
    expect(formatMonth('2026-09')).toBe('setembro de 2026');
    expect(formatMonth('2027-01')).toBe('janeiro de 2027');
  });
});

describe('formatMonthName (#233)', () => {
  it('names the month alone, in lower case as pt-BR writes it', () => {
    expect(formatMonthName('2026-10')).toBe('outubro');
    expect(formatMonthName('2026-09')).toBe('setembro');
    // The first of the month in UTC: no time zone moves it into December.
    expect(formatMonthName('2027-01')).toBe('janeiro');
  });
});

describe('chart date-axis ticks (SPEC-022 BR-022-42)', () => {
  it('ticks a daily series as month and year', () => {
    expect(formatAxisMonthYear('2025-11-30')).toBe('nov/25');
    expect(formatAxisMonthYear('2026-01-02')).toBe('jan/26');
  });

  it('ticks a monthly series as the month alone', () => {
    expect(formatAxisMonth('2026-09')).toBe('set');
    expect(formatAxisMonth('2026-05')).toBe('mai');
    expect(formatAxisMonth('2026-12-31')).toBe('dez');
  });

  it('drops the full stop Intl puts after an abbreviated month', () => {
    for (let month = 1; month <= 12; month += 1) {
      const key = `2026-${String(month).padStart(2, '0')}`;
      expect(formatAxisMonth(key)).toMatch(/^[a-zç]{3}$/);
    }
  });

  it('ticks a short daily range as day and month', () => {
    expect(formatAxisDayMonth('2026-09-30')).toBe('30/09');
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

describe('formatDate', () => {
  it('renders an instant as dd/mm/yyyy in São Paulo time, not UTC', () => {
    // 2026-03-17T01:00Z is still the 16th in São Paulo.
    expect(formatDate(new Date('2026-03-17T01:00:00Z'))).toBe('16/03/2026');
  });
});
