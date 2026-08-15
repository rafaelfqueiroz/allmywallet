import { toCsv } from '@/lib/csv';
import type { GroupedReport, ReportGroup, ReportHolding } from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-12 / AC-11 — "any grouped view is exportable to CSV with the
 * grouping preserved, with formula-injection neutralisation."
 *
 * **Neutralisation is not implemented here.** `src/lib/csv.ts` already does it
 * (SPEC-003 BR-003-13, AR-55) and this module calls `toCsv`, which runs
 * `neutralizeCsvCell` on every field before RFC 4180 quoting. A second
 * implementation is how the two drift and one of them stops covering `@` — so
 * there is exactly one, and this file must never construct a CSV row by
 * joining strings itself.
 *
 * AR-01: no `next/*`, no adapter. This produces a string; the route handler
 * (AR-33) streams it.
 */

/**
 * Column headings arrive from the caller rather than being written here.
 *
 * AR-44 puts user-facing text in `next-intl`, and AR-01 forbids `core/`
 * importing it — so the two rules together mean the domain cannot name its own
 * columns. The route handler resolves the pt-BR headings and passes them in.
 * That also keeps the market vocabulary correct at the surface where it is
 * read (AR-46): *patrimônio*, not "net worth".
 */
export interface CsvLabels {
  readonly group: string;
  readonly assetCode: string;
  readonly assetName: string;
  readonly quantity: string;
  readonly value: string;
  readonly costBasis: string;
  readonly estimated: string;
  /** BR-011-09 — the Unassigned bucket's heading. */
  readonly unassigned: string;
  /** BR-011-10 — the "Not classified" bucket's heading. */
  readonly notClassified: string;
  /** Rendered in the `estimated` column (BR-011-15). */
  readonly yes: string;
  readonly no: string;
  /** The trailing scope-total row's label. */
  readonly total: string;
}

/**
 * Resolves a group's display name. Synthetic buckets take their i18n label;
 * everything else takes the name the caller resolved from tenant data (a
 * wallet name, an asset code, a sector), falling back to the raw id so a group
 * can never silently export as an empty cell.
 */
export type GroupLabeller = (group: ReportGroup) => string;

export function defaultGroupLabeller(
  labels: CsvLabels,
  names: ReadonlyMap<string, string>,
): GroupLabeller {
  return (group) => {
    if (group.key.synthetic) {
      return group.key.dimension === 'wallet' ? labels.unassigned : labels.notClassified;
    }
    return names.get(group.key.id) ?? group.key.id;
  };
}

/**
 * BR-011-12 — the grouped export.
 *
 * **The grouping is preserved, not flattened.** Every row carries its group in
 * the first column, and the rows are emitted in the report's own group order,
 * so a spreadsheet pivot reproduces exactly the figures that were on screen.
 * An export that dropped the group column would turn a grouped view into an
 * ungrouped one and quietly break the correspondence the user is exporting
 * *for*.
 *
 * **AR-06/AR-10: money crosses as `Money.toString()`**, the full-precision
 * plain decimal string. Never `toFixed`, never a `number`, and never a
 * locale-formatted figure — a CSV is data, and `R$ 1.234,56` is a rendering
 * that a spreadsheet would re-parse as text or, worse, as a different number.
 * Formatting is the reader's job; precision is ours.
 */
export function exportGroupedCsv(
  report: GroupedReport,
  labels: CsvLabels,
  labelFor: GroupLabeller,
): string {
  const rows: string[][] = [
    [
      labels.group,
      labels.assetCode,
      labels.assetName,
      labels.quantity,
      labels.value,
      labels.costBasis,
      labels.estimated,
    ],
  ];

  for (const group of report.groups) {
    const groupLabel = labelFor(group);
    for (const holding of group.holdings) {
      rows.push(holdingRow(groupLabel, holding, labels));
    }
  }

  // BR-011-08 made checkable in the exported artifact: the scope total travels
  // with the rows, so a reader can add the value column up and see it agree
  // without re-opening the report.
  rows.push([
    labels.total,
    '',
    '',
    report.total.quantity.toString(),
    report.total.value.toString(),
    report.total.costBasis.toString(),
    report.total.estimated ? labels.yes : labels.no,
  ]);

  return toCsv(rows);
}

function holdingRow(groupLabel: string, holding: ReportHolding, labels: CsvLabels): string[] {
  return [
    groupLabel,
    holding.assetCode,
    holding.assetName,
    holding.quantity.toString(),
    holding.value.toString(),
    holding.costBasis.toString(),
    holding.estimated ? labels.yes : labels.no,
  ];
}
