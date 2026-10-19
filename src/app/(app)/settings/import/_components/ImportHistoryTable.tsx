'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import type { ImportBatchStatus } from '@/core/ingestion/ports';
import { importBatchPath } from '@/lib/import-paths';
import { BATCH_STATUS_VARIANT } from '@/app/(app)/settings/import/_components/batch-status';
import { DataTable } from '@/components/patterns/data-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * SPEC-022 BR-022-16/18/31 — Configurações › Importar › **Histórico**: every
 * batch, as a table that sorts, filters and pages, so a long history never
 * pushes anything else down a page (it used to sit between the upload and the
 * export guide, #211).
 *
 * Everything arrives as text or a number, formatted on the server
 * (`formatDateTime`), the same contract as `WalletsTable`: a Client Component
 * receives serialised props, and the date format is decided once.
 *
 * The status cell carries its label as the sort and filter value, so typing
 * "Importado" in the search narrows to committed batches — what the user reads
 * is what they search.
 */
export interface ImportHistoryRow {
  readonly id: string;
  /** "Negociação", "Movimentação", "Posição" — or the pending placeholder. */
  readonly typeLabel: string;
  readonly status: ImportBatchStatus;
  readonly statusLabel: string;
  /** `dd/mm/yyyy hh:mm`, formatted on the server. */
  readonly sentAtText: string;
  /** Epoch milliseconds: the sort key for "Enviado em", never displayed. */
  readonly sentAtMs: number;
  /** Rows read from the file; `null` until the batch has been staged. */
  readonly rowsRead: number | null;
}

export function ImportHistoryTable({ rows }: { readonly rows: readonly ImportHistoryRow[] }) {
  const t = useTranslations('import.history');

  const columns = useMemo<ColumnDef<ImportHistoryRow, unknown>[]>(
    () => [
      {
        id: 'type',
        header: t('columnType'),
        // SPEC-022 BR-022-18: every column's kind and width are the table's.
        meta: { kind: 'text', width: 16 },
        accessorFn: (row) => row.typeLabel,
        cell: ({ row }) => <span className="font-medium">{row.original.typeLabel}</span>,
      },
      {
        id: 'sentAt',
        header: t('columnSentAt'),
        // `dd/mm/yyyy hh:mm`: sixteen characters, wider than a date alone.
        meta: { kind: 'date', width: 17 },
        accessorFn: (row) => row.sentAtMs,
        sortingFn: 'basic',
        cell: ({ row }) => <span className="tabular-nums">{row.original.sentAtText}</span>,
      },
      {
        id: 'status',
        header: t('columnStatus'),
        // Sized for the longest status label, "Não foi possível processar" (26
        // characters in the 12px badge, plus its dot): at the badge default
        // (14) a failed import read "Não foi possível" and was cut. Any label
        // that still does not fit ends in an ellipsis with its text on demand.
        meta: { kind: 'badge', width: 26 },
        accessorFn: (row) => row.statusLabel,
        cell: ({ row }) => (
          <Badge dot variant={BATCH_STATUS_VARIANT[row.original.status]}>
            {row.original.statusLabel}
          </Badge>
        ),
      },
      {
        id: 'rows',
        header: t('columnRows'),
        meta: { kind: 'number', width: 9 },
        // A batch not yet staged has no count; it sorts below every staged one.
        accessorFn: (row) => row.rowsRead ?? -1,
        sortingFn: 'basic',
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.rowsRead === null ? t('noRows') : row.original.rowsRead}
          </span>
        ),
      },
      {
        id: 'action',
        header: t('columnAction'),
        meta: { kind: 'control', width: '7rem' },
        enableSorting: false,
        cell: ({ row }) => (
          <Button asChild variant="link" size="sm">
            <Link href={importBatchPath(row.original.id)}>
              {t('view')}
              <span className="sr-only">
                {' '}
                {t('viewOf', { type: row.original.typeLabel, date: row.original.sentAtText })}
              </span>
            </Link>
          </Button>
        ),
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={[...rows]}
      caption={t('caption')}
      sortable
      initialSorting={[{ id: 'sentAt', desc: true }]}
      sortLabel={(column) => t('sortBy', { column })}
      sortControlLabels={{
        field: t('sortField'),
        ascending: t('sortAscending'),
        descending: t('sortDescending'),
      }}
      filter={{ placeholder: t('search') }}
      itemNoun={t('noun')}
      empty={<EmptyState title={t('empty')} description={t('emptyBody')} />}
    />
  );
}
