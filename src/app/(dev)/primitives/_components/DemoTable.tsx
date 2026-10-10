'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { Money as MoneyValue, Quantity } from '@/core/shared/money';
import { DataTable } from '@/components/patterns/data-table';
import { Money } from '@/components/patterns/money';

/**
 * `DataTable` for the kitchen sink (DS-42). A Client Component only because
 * column definitions carry cell renderers, and a function cannot cross from
 * the Server Component page.
 *
 * Twenty-three rows at a page size of five, so the photograph shows the
 * pagination with a window of pages, a sorted header and the filter — the
 * SPEC-022 component sheet's "Tabela" panel (BR-022-18).
 */
type Row = { readonly code: string; readonly quantity: string; readonly change: string };

const ROWS: readonly Row[] = Array.from({ length: 23 }, (_, index) => ({
  code: `ATIV${String(index + 1).padStart(2, '0')}`,
  quantity: String((index + 1) * 10),
  change: String((index % 2 === 0 ? 1 : -1) * (index + 1) * 12.5),
}));

export function DemoTable() {
  const vocabulary = useTranslations('vocabulary');

  const columns: ColumnDef<Row, unknown>[] = [
    { accessorKey: 'code', header: vocabulary('patrimonio') },
    {
      accessorKey: 'quantity',
      header: vocabulary('precoMedio'),
      cell: ({ row }) => (
        <Money value={Quantity.fromString(row.original.quantity)} kind="quantity" />
      ),
    },
    {
      accessorKey: 'change',
      header: vocabulary('rentabilidade'),
      cell: ({ row }) => <Money value={MoneyValue.fromString(row.original.change)} signed />,
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={[...ROWS]}
      caption={vocabulary('proventos')}
      sortable
      initialSorting={[{ id: 'code', desc: false }]}
      sortLabel={(column) => column}
      defaultPageSize={5}
      pageSizeOptions={[5, 10, 25]}
      filter={{ placeholder: vocabulary('composicao') }}
      paramPrefix="demo"
    />
  );
}
