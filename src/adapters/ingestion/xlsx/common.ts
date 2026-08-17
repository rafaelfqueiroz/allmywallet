import type ExcelJS from 'exceljs';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';

/**
 * Shared plumbing for the three parsers (`movimentacao.ts`, `negociacao.ts`,
 * `posicao.ts`). AR-01 does not apply here — this is `adapters/`, so
 * `exceljs` is fine — but AR-06/AR-08 still do: every numeric cell becomes a
 * `Money`/`Quantity` via a decimal-literal string, never `Number(...)` or
 * `parseFloat`.
 */

/**
 * SPEC-005 BR-005-05 (#63) — thrown by `parseBrDate`/`parseBrDecimal` on a
 * cell that does not match the format its column requires. `index.ts`
 * catches this at the per-row parse dispatch and turns it into
 * `IngestionErrorCode.MALFORMED_CELL`, which is what makes the failure a
 * `DomainError` a caller can act on instead of a `TypeError` that crashes the
 * `import.stage` job outright.
 *
 * Carries the column header and the expected format only — **never** the
 * cell's own text. BR-004-04/AR-39: a malformed cell's contents could be
 * anything, including a CPF, and this error is exactly the kind of thing that
 * gets logged (`import.ts`) and stored (`import_batches.failure_code`'s
 * sibling context) — so the one thing it must never carry is the value that
 * failed.
 */
export class CellFormatError extends Error {
  constructor(
    readonly column: string,
    readonly expected: string,
  ) {
    super(`column "${column}" does not match the expected format (${expected})`);
    this.name = 'CellFormatError';
  }
}

/** A worksheet reduced to text, one row per array — what `detect.ts` operates on. */
export function sheetToRows(worksheet: ExcelJS.Worksheet): (string | null)[][] {
  const rows: (string | null)[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: (string | null)[] = [];
    // `row.eachCell` skips empty cells by default; `includeEmpty` keeps
    // column positions aligned with the header row's own indices.
    row.eachCell({ includeEmpty: true }, (cell) => {
      const text = cellText(cell);
      cells.push(text === '' ? null : text);
    });
    rows.push(cells);
  });
  return rows;
}

export function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatBrDate(value);
  if (typeof value === 'object' && 'result' in value) {
    // A formula cell — B3 extracts do not carry these, but a defensive read
    // of the last computed result is safer than throwing on export quirks.
    return String((value as { result: unknown }).result ?? '');
  }
  return String(value).trim();
}

function formatBrDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * B3 dates are `DD/MM/YYYY`. `column` is structural metadata for
 * `CellFormatError` (BR-005-05) — the header the caller read this cell from,
 * never the cell's own text.
 */
export function parseBrDate(text: string, column: string): BusinessDate {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) throw new CellFormatError(column, 'DD/MM/YYYY');
  const [, day, month, year] = match;
  return BusinessDate.of(`${year}-${month}-${day}`);
}

/**
 * B3 numeric cells use a comma decimal separator and `.` thousands grouping
 * (`1.234,56`) when exported as text, or arrive as a native Excel number.
 * Never `Number(...)`/`parseFloat` (AR-06) — the literal is normalised to a
 * plain decimal string and handed to `Quantity`/`Money`'s own parser.
 *
 * `column` — see `parseBrDate`.
 */
export function parseBrDecimal(text: string, column: string): string {
  const trimmed = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed; // already a plain decimal literal
  const normalized = trimmed.replaceAll('.', '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new CellFormatError(column, 'decimal number (e.g. 1.234,56 or 1234.56)');
  }
  return normalized;
}

export function parseQuantity(text: string, column: string): Quantity {
  return Quantity.fromString(parseBrDecimal(text, column));
}

export function parseMoney(text: string, column: string): Money {
  return Money.fromString(parseBrDecimal(text, column));
}

export function cellAt(
  row: readonly (string | null)[],
  columns: ReadonlyMap<string, number>,
  header: string,
): string | null {
  const index = columns.get(header);
  if (index === undefined) return null;
  return row[index] ?? null;
}
