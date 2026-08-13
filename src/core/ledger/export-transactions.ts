import { toCsv } from '@/lib/csv';
import type {
  TransactionFilter,
  TransactionListItem,
  TransactionRepository,
} from '@/core/ledger/ports';

/**
 * SPEC-006 BR-006-10: CSV export **honouring the active filters**, with
 * formula-injection neutralisation (SPEC-003 BR-003-13, AR-55).
 *
 * The filter is passed through to the same repository query the list uses, so
 * "export what I am looking at" cannot drift from what the user is actually
 * looking at. An export that quietly widened to the whole ledger would be a
 * privacy surprise as much as a usability one.
 *
 * Neutralisation is not optional decoration. Asset and institution names reach
 * this file from a parsed B3 extract — text the export did not author. A cell
 * whose content is literally `=cmd|'/c calc'!A1`, or a `WEBSERVICE()` call that
 * posts the rest of the row to a third party, executes the moment the file is
 * opened in Excel. `toCsv` prefixes such cells with a single quote; every cell
 * below goes through it, including the ones that "obviously" hold a number,
 * because a negative amount starts with `-` and `-` is one of the four
 * trigger characters.
 */

/**
 * Column order is the reading order of the history list, so the export matches
 * what was on screen. Header text is English here on purpose: this is the
 * machine-readable artefact, and its column names are consumed by
 * spreadsheets and scripts rather than read as UI copy (AR-44 governs the
 * latter). A localised header row is a display concern the app layer can add.
 */
const HEADER = [
  'trade_date',
  'asset_code',
  'asset_name',
  'asset_class',
  'institution',
  'type',
  'status',
  'quantity',
  'unit_price',
  'fees',
  'total_value',
  'ratio',
  'provenance',
  'user_modified',
] as const;

/**
 * BR-006-02: provenance is part of the export, not only the UI. A number in a
 * report has to be explainable back to its source, and an export that dropped
 * the distinction between "B3 said so" and "I typed this" would lose exactly
 * the information a reconciliation needs.
 */
function provenanceOf(item: TransactionListItem): string {
  return item.transaction.importBatchId === null
    ? 'manual'
    : `import:${item.transaction.importBatchId}`;
}

export function toCsvRows(items: readonly TransactionListItem[]): readonly (readonly string[])[] {
  return [
    HEADER,
    ...items.map((item) => {
      const t = item.transaction;
      return [
        t.tradeDate,
        item.assetCode,
        item.assetName,
        item.assetClass,
        item.institutionName ?? '',
        t.type,
        t.status,
        // AR-06/AR-10: full-precision plain decimal strings, never a float and
        // never exponential notation. A spreadsheet reading `1e-8` where the
        // ledger holds `0.00000001` is the same corruption as a float, arriving
        // by a different door.
        t.quantity.toString(),
        t.unitPrice.toString(),
        t.fees.toString(),
        t.totalValue.toString(),
        t.ratio === null ? '' : t.ratio.toString(),
        provenanceOf(item),
        // BR-006-16: whether a human has corrected this row.
        t.isUserModified ? 'true' : 'false',
      ];
    }),
  ];
}

export async function exportTransactionsCsv(
  transactions: TransactionRepository,
  filter: TransactionFilter,
): Promise<string> {
  const items = await transactions.export(filter);
  return toCsv(toCsvRows(items));
}
