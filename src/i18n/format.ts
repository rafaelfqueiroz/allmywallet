import type { Money, Quantity } from '@/core/shared/money';
import type { BusinessDate } from '@/core/shared/clock';
import { DEFAULT_LOCALE } from '@/i18n/locale';
import { MASKED_CURRENCY } from '@/i18n/masked';

/**
 * AR-09/AR-47: this is the only place rounding is permitted, and the only place
 * currency and dates are formatted. Never inline `toLocaleString` — the point
 * of a single formatter is that `R$ 1.234,56` and `dd/mm/yyyy` are decided once.
 */

const currencyFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Share counts can be fractional (FIIs, fractional lots) but rarely need 8 dp. */
const quantityFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

/**
 * `Number(...)` appears here and nowhere else. It is safe *only* because this
 * is the terminal display step: the value has already been persisted and
 * computed at full precision, and nothing downstream reads what this returns.
 */
export function formatCurrency(value: Money): string {
  return currencyFormatter.format(Number(value.toString()));
}

/**
 * For the few amounts a page has to produce as a **string** rather than as a
 * `<Money>` element — a `title` attribute, a cell handed to a Client
 * Component, a phrase interpolated into a translation (BR-022-24). Prefer
 * `<Money>` wherever an element can go: its placeholder carries an accessible
 * name, and a string cannot.
 */
export function currencyText(masked: boolean): (value: Money) => string {
  return masked ? () => MASKED_CURRENCY : formatCurrency;
}

export function formatQuantity(value: Quantity): string {
  return quantityFormatter.format(Number(value.toString()));
}

/**
 * Takes a value **already expressed in percentage points** — 118 renders as
 * "118,00%".
 *
 * Distinct from `formatPercent` because `Intl`'s `style: 'percent'` multiplies
 * by 100, so handing it a figure that is already a percentage multiplies
 * twice. SPEC-012's "% do CDI" is the one measure computed that way (its
 * domain type is `Quantity`, not `Rate`, precisely because it is not a
 * fraction), and it reached the screen as `11.800,00%` for a portfolio that
 * had beaten CDI by 18%.
 */
const percentPointsFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPercentPoints(points: Money | Quantity): string {
  return `${percentPointsFormatter.format(Number(points.toString()))}%`;
}

/** Takes a fraction — 0.1234 renders as "12,34%". */
export function formatPercent(fraction: Money | Quantity): string {
  return percentFormatter.format(Number(fraction.toString()));
}

/**
 * SPEC-022 BR-022-38 — a money chart's **value-axis tick**, in abbreviated
 * reais: "R$ 250 mil", "R$ 1,2 mi", and whole reais below one thousand.
 *
 * The one formatter here that takes a `number`, because a tick is a scale mark
 * Recharts computes from the plotting coordinates — not a figure anybody reads
 * as an amount. Every figure a chart shows — its tooltip — comes from the
 * decimal on the server instead (`chartTip`, AR-09).
 */
const axisWholeFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const axisCompactFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function formatAxisCurrency(coordinate: number): string {
  return Math.abs(coordinate) < 1000
    ? axisWholeFormatter.format(coordinate)
    : axisCompactFormatter.format(coordinate);
}

/**
 * A percentage-points axis tick — 4,5 renders as "4,5%". For the benchmark
 * comparison, whose axis is a scale of returns, never money. Same reasoning as
 * `formatAxisCurrency`: a tick is a scale mark, so a `number` is acceptable.
 */
const axisPointsFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  maximumFractionDigits: 1,
});

export function formatAxisPercentPoints(coordinate: number): string {
  return `${axisPointsFormatter.format(coordinate)}%`;
}

/** AR-29: business dates carry no time and no zone, so this is pure string work. */
export function formatBusinessDate(date: BusinessDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * A `YYYY-MM` month as a reader says it — "setembro de 2026". AR-29: a month
 * is not a `BusinessDate`, so it is formatted as the first of the month in UTC,
 * which no time zone can move into the month before.
 */
const monthFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatMonth(month: string): string {
  const [year = '', index = ''] = month.split('-');
  return monthFormatter.format(new Date(Date.UTC(Number(year), Number(index) - 1, 1)));
}

/**
 * An instant as `dd/mm/yyyy` in the business time zone — for "Atualizada em",
 * where the day matters and the hour does not. Never `toLocaleDateString`
 * inline (AR-47).
 */
export function formatDate(instant: Date): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(instant);
}

export function formatDateTime(instant: Date): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(instant);
}
