'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { ColorSwatch } from '@/components/patterns/color-swatch';
import { DataTable } from '@/components/patterns/data-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { Cluster } from '@/components/layout/cluster';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';

/**
 * SPEC-022 BR-022-05 — Configurações › Carteiras' list: setup data only. A
 * wallet's name and description, its purpose, **how many assets** are allocated
 * to it and when it last changed. No value, no cost, no share (those are
 * Portfólio's), and the count is a count of assets, never a sum of their
 * quantities across different assets (BR-022-34's reasoning).
 *
 * Everything arrives as text or an integer, already formatted on the server
 * (`formatDate`), the same contract as `HoldingsTable`: a Client Component
 * receives serialised props, and the date format is decided once.
 *
 * The colour is a swatch beside the name. It is decoration — the name carries
 * the identity — so it is hidden from assistive technology, and a wallet with
 * no colour shows an empty ring rather than a black one.
 *
 * Sorting by every column is client-side over the whole list; the list is
 * paginated and filterable like every table (BR-022-18), with its state in the
 * URL.
 */
export interface WalletRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly goal: string | null;
  readonly color: string | null;
  readonly assetCount: number;
  /** `dd/mm/yyyy`, formatted on the server. */
  readonly updatedAtText: string;
  /** Epoch milliseconds: the sort key for "Atualizada em", never displayed. */
  readonly updatedAtMs: number;
}

export function WalletsTable({ rows }: { readonly rows: readonly WalletRow[] }) {
  const t = useTranslations('wallets');

  const columns = useMemo<ColumnDef<WalletRow, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('list.columnWallet'),
        accessorFn: (row) => row.name,
        cell: ({ row }) => (
          <Cluster gap="sm" align="center" className="flex-nowrap">
            <ColorSwatch color={row.original.color} />
            <Stack gap="none">
              <Link
                href={`/settings/wallets/${row.original.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.original.name}
              </Link>
              {row.original.description !== null && (
                <Text as="span" size="xs" tone="muted">
                  {row.original.description}
                </Text>
              )}
            </Stack>
          </Cluster>
        ),
      },
      {
        id: 'goal',
        header: t('list.columnGoal'),
        accessorFn: (row) => row.goal ?? '',
        cell: ({ row }) => row.original.goal ?? t('list.noGoal'),
      },
      {
        id: 'assets',
        header: t('list.columnAssets'),
        accessorFn: (row) => row.assetCount,
        sortingFn: 'basic',
        cell: ({ row }) => <span className="tabular-nums">{row.original.assetCount}</span>,
      },
      {
        id: 'updatedAt',
        header: t('list.columnUpdated'),
        accessorFn: (row) => row.updatedAtMs,
        sortingFn: 'basic',
        cell: ({ row }) => <span className="tabular-nums">{row.original.updatedAtText}</span>,
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={[...rows]}
      caption={t('list.caption')}
      sortable
      initialSorting={[{ id: 'name', desc: false }]}
      sortLabel={(column) => t('list.sortBy', { column })}
      sortControlLabels={{
        field: t('list.sortField'),
        ascending: t('list.sortAscending'),
        descending: t('list.sortDescending'),
      }}
      filter={{ placeholder: t('list.search') }}
      itemNoun={t('list.noun')}
      empty={<EmptyState title={t('empty')} description={t('list.emptyBody')} />}
    />
  );
}
