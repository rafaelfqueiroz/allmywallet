import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { audit, render, screen, within } from '@/components/test-utils';

// The table reads its state from the URL; only the search string matters here.
const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/relatorios',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => {
  nav.search = '';
});

/*
 * SPEC-012 BR-012-16 — a closing row the reader checks the rows against. It
 * belongs to the whole collection: every page shows it, and a filter does not
 * change it.
 */
type Line = { code: string; gain: string };

const lines: Line[] = Array.from({ length: 12 }, (_, index) => ({
  code: `ATIVO${index + 1}`,
  gain: '1',
}));

const columns: ColumnDef<Line, unknown>[] = [
  { id: 'code', header: 'Ativo', meta: { kind: 'text' }, accessorFn: (row) => row.code },
  { id: 'gain', header: 'Ganho', meta: { kind: 'money' }, cell: ({ row }) => row.original.gain },
];

const totals = { label: 'Total', cells: { gain: 'R$ 12,00' } };

describe('DataTable totals', () => {
  it('closes the table with its total, in the first column and under its own column', () => {
    render(<DataTable columns={columns} data={lines} caption="Linhas" totals={totals} />);
    const table = screen.getByRole('table', { name: 'Linhas' });
    const footerRow = within(table)
      .getAllByRole('row')
      .find((row) => within(row).queryByRole('rowheader', { name: 'Total' }) !== null);
    expect(footerRow).toBeDefined();
    expect(within(footerRow!).getByRole('cell')).toHaveTextContent('R$ 12,00');
    // Twelve rows, ten to a page: the header, the page, and the total.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10 + 1);
  });

  it('is not filtered with the rows', () => {
    nav.search = 'q=ATIVO11';
    render(
      <DataTable
        columns={columns}
        data={lines}
        caption="Linhas"
        totals={totals}
        filter={{ placeholder: 'Filtrar' }}
      />,
    );
    const table = screen.getByRole('table', { name: 'Linhas' });
    // One row matches; the total is still the total of all twelve.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 1 + 1);
    expect(within(table).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'R$ 12,00' })).toBeInTheDocument();
  });

  it('repeats the total under the card list, labelled with its column, not as a record', () => {
    render(<DataTable columns={columns} data={lines} caption="Linhas" totals={totals} />);
    const list = screen.getByRole('list');
    // One page of records (10 of 12); the total sums them and is not one of them.
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).queryByText('Total')).toBeNull();
    const card = list.nextElementSibling as HTMLElement;
    expect(within(card).getByText('Total')).toBeInTheDocument();
    expect(within(card).getByRole('definition')).toHaveTextContent('R$ 12,00');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <DataTable columns={columns} data={lines} caption="Linhas" totals={totals} />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
