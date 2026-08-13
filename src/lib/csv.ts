/**
 * SPEC-003 BR-003-13 / AR-55: exported CSV cells beginning `=`, `+`, `-` or
 * `@` are neutralised to prevent formula injection in the recipient's
 * spreadsheet.
 *
 * The threat: a value the export did not author — an institution name from a
 * parsed B3 extract, an asset name from a corporate action feed — can contain
 * attacker-influenced text. Opened in Excel or LibreOffice, a cell whose
 * content is literally `=cmd|'/c calc'!A1` (or a `HYPERLINK`/`WEBSERVICE` call
 * that exfiltrates the rest of the row) executes as a formula the moment the
 * file opens. An export turns from data into code execution on the user's own
 * machine.
 *
 * Mitigation (OWASP CSV injection guidance): prefix the cell with a leading
 * single quote when it starts with one of the four trigger characters. Excel
 * and LibreOffice both treat a leading `'` as "this is text", which renders
 * the formula inertly as its literal characters instead of evaluating it.
 */

const FORMULA_TRIGGER_CHARACTERS = ['=', '+', '-', '@'] as const;

export function neutralizeCsvCell(value: string): string {
  if (FORMULA_TRIGGER_CHARACTERS.some((trigger) => value.startsWith(trigger))) {
    return `'${value}`;
  }
  return value;
}

/**
 * RFC 4180 quoting for a single field: wrap in `"..."` and double any
 * embedded quote, but only when the field actually needs it — a field with no
 * comma, quote or newline is left bare, which is what every spreadsheet
 * expects for the common case.
 *
 * Neutralisation runs *before* quoting, so a formula-triggering value that
 * also needs RFC 4180 quoting is not left exposed by ordering.
 */
export function toCsvField(value: string): string {
  const neutralized = neutralizeCsvCell(value);
  const needsQuoting = /[",\n\r]/.test(neutralized);
  if (!needsQuoting) return neutralized;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

export function toCsvRow(cells: readonly string[]): string {
  return cells.map(toCsvField).join(',');
}

/** `\r\n` line endings — the RFC 4180 default, and what Excel expects. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map(toCsvRow).join('\r\n');
}
