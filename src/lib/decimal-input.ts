/**
 * Turns whatever a Brazilian user (or a B3 spreadsheet) actually typed into a
 * plain decimal literal — `1.234,56` and `1234.56` both become `1234.56`.
 *
 * **Never `Number(...)` or `parseFloat` (AR-06).** The output is a *string*,
 * handed to `Money`/`Quantity`'s own parser, so no monetary value ever exists
 * as a JS float even momentarily. Returning `null` rather than throwing is the
 * point at a form boundary: a mistyped price is an ordinary thing a user does
 * and the field has to say so, not raise.
 *
 * The rule, and why it is not ambiguous:
 *
 *  - a plain `-?\d+(\.\d+)?` literal is already canonical and passes through
 *    untouched, which is what a `<input type="number">` submits;
 *  - otherwise `.` is a thousands separator and `,` is the decimal separator,
 *    which is what pt-BR keyboards, pt-BR spreadsheets and B3's own exports
 *    all produce.
 *
 * That leaves `1.234` reading as one thousand two hundred and thirty-four
 * rather than as 1.234 — correct for this locale, and the reason the canonical
 * form is tested *first* so a machine-generated `1.234` still means 1.234.
 */
export function normalizeDecimalInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;

  const normalized = trimmed.replaceAll('.', '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}
