import type { ImportRow } from '@/core/ingestion/ports';
import { formatBusinessDate } from '@/i18n/format';
import { TableCell } from '@/components/ui/table';

/**
 * SPEC-022 BR-022-18 (#211) — the leading cells every row table on a batch's
 * page shares: the asset, B3's own movement name and the trade date. A Posição
 * row has neither a movement nor a date, so those cells stay empty rather than
 * shifting the columns.
 */
export function RowCells({ row }: { readonly row: ImportRow }) {
  return (
    <>
      <TableCell className="py-row align-top font-medium">{row.record.assetCode}</TableCell>
      <TableCell className="py-row align-top whitespace-normal">
        {row.record.kind === 'transaction' ? row.record.b3Type : ''}
      </TableCell>
      <TableCell className="py-row align-top tabular-nums">
        {row.record.kind === 'transaction' ? formatBusinessDate(row.record.tradeDate) : ''}
      </TableCell>
    </>
  );
}
