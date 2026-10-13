import type { ReactNode } from 'react';
import type { ImportRow } from '@/core/ingestion/ports';
import { formatBusinessDate } from '@/i18n/format';
import type { NodeColumn } from '@/components/patterns/node-table';

/**
 * SPEC-022 BR-022-18 (#211, #237) — the leading columns every row table on a
 * batch's page shares: the asset, B3's own movement name and the trade date. A
 * Posição row has neither a movement nor a date, so those cells stay empty
 * rather than shifting the columns.
 *
 * Kinds and widths are the table standard's (DS-67): text and dates sit left,
 * the movement name — "Direitos de Subscrição - Exercido" is the longest —
 * ends in an ellipsis with its full text on demand rather than widening the
 * column.
 */
export function rowIdentityColumns(labels: {
  readonly asset: string;
  readonly movement: string;
  readonly date: string;
}): NodeColumn[] {
  return [
    { id: 'asset', header: labels.asset, kind: 'text', width: 14 },
    { id: 'movement', header: labels.movement, kind: 'text', width: 26 },
    { id: 'date', header: labels.date, kind: 'date' },
  ];
}

export function rowIdentityCells(row: ImportRow): {
  readonly asset: ReactNode;
  readonly movement: ReactNode;
  readonly date: ReactNode;
} {
  return {
    asset: <span className="font-medium">{row.record.assetCode}</span>,
    movement: row.record.kind === 'transaction' ? row.record.b3Type : '',
    date: row.record.kind === 'transaction' ? formatBusinessDate(row.record.tradeDate) : '',
  };
}
