import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { Money as MoneyValue } from '@/core/shared/money';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

// The table mirrors its state into the URL, so it needs the router. A test
// drives the mirror through `search` and reads what was written off `replace`.
const nav = vi.hoisted(() => ({ search: '', pathname: '/posicoes', replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
});

type Position = { code: string; cost: MoneyValue };

const rows: Position[] = [
  { code: 'PETR4', cost: MoneyValue.fromString('1000') },
  { code: 'HGLG11', cost: MoneyValue.fromString('2500.50') },
];

const columns: ColumnDef<Position, unknown>[] = [
  { accessorKey: 'code', header: 'Ativo', cell: ({ row }) => row.original.code },
  { accessorKey: 'cost', header: 'Custo', cell: ({ row }) => <Money value={row.original.cost} /> },
];

function Positions({ data = rows }: { data?: Position[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      caption="Posições"
      empty={<EmptyState title="Nada por aqui ainda" />}
    />
  );
}

describe('DataTable', () => {
  it('renders a real table with the caption as its accessible name', () => {
    render(<Positions />);
    const table = screen.getByRole('table', { name: 'Posições' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
  });

  it('renders one row per record', () => {
    render(<Positions />);
    const table = screen.getByRole('table');
    // Header row plus two data rows.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  /*
   * DL-12 — the card list is a second rendering, not responsive classes on the
   * first. Both are in the DOM and CSS chooses; jsdom applies no CSS, so both
   * are visible to these queries. That is what lets the test assert the mobile
   * rendering exists at all without driving a viewport.
   */
  it('renders a card list alongside the table for small screens', () => {
    render(<Positions />);
    const list = screen.getByRole('list', { name: 'Posições' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('repeats each column header as a field label in the card list', () => {
    render(<Positions />);
    const list = screen.getByRole('list', { name: 'Posições' });

    // Without this the cards are unlabelled values — "PETR4" above "R$ 1.000,00"
    // with nothing saying which is which.
    expect(within(list).getAllByText('Ativo')).toHaveLength(2);
    expect(within(list).getAllByText('Custo')).toHaveLength(2);
  });

  it('shows the empty state instead of an empty table', () => {
    render(<Positions data={[]} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Positions />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations when empty', async () => {
    const { container } = render(<Positions data={[]} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

/**
 * SPEC-015 AC-4 — "the table sorts by every column, ascending and descending."
 *
 * The affordance lives here rather than in the Composition screen so the next
 * sortable table cannot re-decide the icon, the button or the `aria-sort`
 * wiring and get one of the three subtly wrong.
 */
describe('DataTable — sorting', () => {
  function Sortable() {
    return (
      <DataTable
        columns={columns}
        data={rows}
        caption="Posições"
        sortable
        sortLabel={(column) => `Ordenar por ${column}`}
      />
    );
  }

  it('leaves headers as plain text when sorting is not asked for', () => {
    render(<Positions />);
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
  });

  it('turns each header into a control that says what it does', () => {
    render(<Sortable />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('button', { name: 'Ordenar por Ativo' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Ordenar por Custo' })).toBeInTheDocument();
  });

  it('sorts ascending, then descending, and says so through aria-sort', async () => {
    const user = userEvent.setup();
    render(<Sortable />);
    const table = screen.getByRole('table');

    const codeOf = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

    // Unsorted: the order the data arrived in.
    expect(codeOf()).toEqual(['PETR4', 'HGLG11']);

    await user.click(within(table).getByRole('button', { name: 'Ordenar por Ativo' }));
    expect(codeOf()).toEqual(['HGLG11', 'PETR4']);
    expect(within(table).getByRole('columnheader', { name: /Ativo/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    await user.click(within(table).getByRole('button', { name: 'Ordenar por Ativo' }));
    expect(codeOf()).toEqual(['PETR4', 'HGLG11']);
    expect(within(table).getByRole('columnheader', { name: /Ativo/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('marks only the sorted column, so the others are not announced as unsorted', async () => {
    const user = userEvent.setup();
    render(<Sortable />);
    const table = screen.getByRole('table');

    await user.click(within(table).getByRole('button', { name: 'Ordenar por Ativo' }));
    expect(within(table).getByRole('columnheader', { name: /Custo/ })).not.toHaveAttribute(
      'aria-sort',
    );
  });

  it('opens on the column it was told to', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        caption="Posições"
        sortable
        initialSorting={[{ id: 'code', desc: true }]}
        sortLabel={(column) => `Ordenar por ${column}`}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: /Ativo/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('has no axe violations when sortable', async () => {
    const { container } = render(<Sortable />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

/**
 * SPEC-022 BR-022-18 — pagination with a selectable page size, a filter, and
 * state in the URL.
 */
describe('DataTable — pagination, filter and URL state', () => {
  type Item = { name: string; status: string };

  const items: Item[] = Array.from({ length: 12 }, (_, index) => ({
    name: `arquivo-${String(index + 1).padStart(2, '0')}.xlsx`,
    status: index % 3 === 0 ? 'Falhou' : 'Concluída',
  }));

  const itemColumns: ColumnDef<Item, unknown>[] = [
    { accessorKey: 'name', header: 'Arquivo' },
    { accessorKey: 'status', header: 'Status' },
  ];

  function Imports({
    data = items,
    ...props
  }: { data?: Item[] } & Partial<ComponentProps<typeof DataTable<Item>>>) {
    return (
      <DataTable
        columns={itemColumns}
        data={data}
        caption="Importações"
        sortable
        sortLabel={(column) => `Ordenar por ${column}`}
        pageSizeOptions={[5, 10]}
        defaultPageSize={5}
        itemNoun="importações"
        filter={{ placeholder: 'Filtrar por arquivo' }}
        {...props}
      />
    );
  }

  const bodyNames = () =>
    within(screen.getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

  const lastReplace = () => nav.replace.mock.lastCall?.[0] as string;
  const writtenParams = () => new URLSearchParams(lastReplace().split('?')[1]);

  it('shows one page of rows and says which, with the noun the caller supplied', () => {
    render(<Imports />);
    expect(bodyNames()).toHaveLength(5);
    expect(screen.getByText('Mostrando 1–5 de 12 importações')).toBeInTheDocument();
  });

  it('paginates both renderings', () => {
    render(<Imports />);
    const list = screen.getByRole('list', { name: 'Importações' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  });

  it('falls back to a generic summary without a noun', () => {
    render(
      <DataTable
        columns={itemColumns}
        data={items}
        caption="Importações"
        pageSizeOptions={[5]}
        defaultPageSize={5}
      />,
    );
    expect(screen.getByText('Mostrando 1–5 de 12')).toBeInTheDocument();
  });

  it('opens on 25 rows per page with 10/25/50/100 on offer by default', () => {
    render(<DataTable columns={itemColumns} data={items} caption="Importações" />);
    const select = screen.getByRole('combobox', { name: 'Itens por página' });
    expect(select).toHaveValue('25');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['10', '25', '50', '100']);
  });

  it('moves between pages with next, previous and the numbered buttons', async () => {
    const user = userEvent.setup();
    render(<Imports />);
    const pagination = screen.getByRole('navigation', { name: 'Paginação' });

    expect(within(pagination).getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(within(pagination).getByRole('button', { name: 'Página 1' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(pagination).getByRole('button', { name: 'Próxima página' }));
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');
    expect(within(pagination).getByRole('button', { name: 'Página 2' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pagination).getByRole('button', { name: 'Página 1' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(lastReplace()).toBe('/posicoes?page=2');

    await user.click(within(pagination).getByRole('button', { name: 'Página 3' }));
    expect(bodyNames()).toEqual(['arquivo-11.xlsx', 'arquivo-12.xlsx']);
    expect(screen.getByText('Mostrando 11–12 de 12 importações')).toBeInTheDocument();
    expect(within(pagination).getByRole('button', { name: 'Próxima página' })).toBeDisabled();

    await user.click(within(pagination).getByRole('button', { name: 'Página anterior' }));
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');
  });

  it('changes the page size and goes back to the first page', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2';
    render(<Imports />);
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Itens por página' }), '10');

    expect(bodyNames()).toHaveLength(10);
    expect(screen.getByText('Mostrando 1–10 de 12 importações')).toBeInTheDocument();
    expect(lastReplace()).toBe('/posicoes?size=10');
  });

  it('reads page, size and sort from the URL', () => {
    nav.search = 'page=2&size=5&sort=name:desc';
    render(<Imports />);
    // Descending by name: 12..08 on page one, 07..03 on page two.
    expect(bodyNames()).toEqual([
      'arquivo-07.xlsx',
      'arquivo-06.xlsx',
      'arquivo-05.xlsx',
      'arquivo-04.xlsx',
      'arquivo-03.xlsx',
    ]);
    expect(screen.getByRole('columnheader', { name: /Arquivo/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('survives unreadable URL values by using the defaults', () => {
    nav.search = 'page=abc&size=7&sort=nope:asc&q=';
    render(<Imports />);
    expect(bodyNames()).toHaveLength(5);
    expect(screen.getByText('Mostrando 1–5 de 12 importações')).toBeInTheDocument();
  });

  it('clamps a page past the end to the last page', () => {
    nav.search = 'page=99';
    render(<Imports />);
    expect(bodyNames()).toEqual(['arquivo-11.xlsx', 'arquivo-12.xlsx']);
  });

  it('writes the sort to the URL and returns to page 1', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2';
    render(<Imports />);

    await user.click(screen.getByRole('button', { name: 'Ordenar por Arquivo' }));

    expect(writtenParams().get('sort')).toBe('name:asc');
    expect(writtenParams().has('page')).toBe(false);
  });

  it('filters by the text of any string column, ignoring case and accents', async () => {
    const user = userEvent.setup();
    render(<Imports pageSizeOptions={[50]} defaultPageSize={50} />);

    await user.type(screen.getByRole('searchbox', { name: 'Filtrar a tabela' }), 'concluida');

    expect(bodyNames()).toHaveLength(8);
    expect(screen.getByText('Mostrando 1–8 de 8 importações')).toBeInTheDocument();
  });

  it('writes the filter text to the URL once typing pauses, and resets the page', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2&wallet=abc';
    render(<Imports />);

    await user.type(screen.getByRole('searchbox'), '12');

    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    expect(writtenParams().get('q')).toBe('12');
    expect(writtenParams().has('page')).toBe(false);
    // Parameters the table does not own are left alone.
    expect(writtenParams().get('wallet')).toBe('abc');
    // One write for the burst, not one per keystroke.
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it('reads the filter text from the URL', () => {
    nav.search = 'q=arquivo-12';
    render(<Imports />);
    expect(bodyNames()).toEqual(['arquivo-12.xlsx']);
    expect(screen.getByRole('searchbox')).toHaveValue('arquivo-12');
  });

  it('shows a no-results message, not the empty state, when a filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<Imports empty={<EmptyState title="Nenhuma importação ainda" />} />);

    await user.type(screen.getByRole('searchbox'), 'zzz');

    expect(screen.getByText('Nenhum resultado para este filtro')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma importação ainda')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The way back stays on screen.
    expect(screen.getByRole('searchbox')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('still shows the caller’s empty state when there is no data at all', () => {
    render(<Imports data={[]} empty={<EmptyState title="Nenhuma importação ainda" />} />);
    expect(screen.getByText('Nenhuma importação ainda')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('renders the toolbar slot beside the filter', () => {
    render(<Imports toolbar={<button type="button">Todos os status</button>} />);
    expect(screen.getByRole('button', { name: 'Todos os status' })).toBeInTheDocument();
  });

  it('keeps two tables on one page apart with a parameter prefix', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2';
    render(<Imports paramPrefix="imports" />);
    // The unprefixed `page` belongs to somebody else.
    expect(bodyNames()[0]).toBe('arquivo-01.xlsx');

    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(writtenParams().get('imports_page')).toBe('2');
    expect(writtenParams().get('page')).toBe('2');
  });

  it('can opt out of pagination for a list that is bounded by construction', () => {
    render(<Imports pagination={false} />);
    expect(bodyNames()).toHaveLength(12);
    expect(screen.queryByRole('navigation', { name: 'Paginação' })).not.toBeInTheDocument();
  });

  it('follows an outside change to the URL', () => {
    const { rerender } = render(<Imports />);
    expect(bodyNames()[0]).toBe('arquivo-01.xlsx');

    nav.search = 'page=2';
    rerender(<Imports />);
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');
  });

  it('does not mistake the arrival of its own write for an outside change', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Imports />);

    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');

    // The URL catches up with what the table already shows.
    nav.search = 'page=2';
    rerender(<Imports />);
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');

    // A later outside navigation to the page-1 URL is still followed.
    nav.search = '';
    rerender(<Imports />);
    expect(bodyNames()[0]).toBe('arquivo-01.xlsx');
  });

  it('has no axe violations with the toolbar and pagination', async () => {
    const { container } = render(<Imports toolbar={<span>extra</span>} />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations when a filter matches nothing', async () => {
    nav.search = 'q=zzz';
    const { container } = render(<Imports />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('gives every control a focus-visible ring', () => {
    render(<Imports />);
    expect(screen.getByRole('searchbox').className).toContain('focus-visible:ring-ring');
    expect(screen.getByRole('button', { name: 'Página 2' }).className).toContain(
      'focus-visible:ring-ring',
    );
    expect(screen.getByRole('combobox', { name: 'Itens por página' }).className).toContain(
      'focus-visible:ring-ring',
    );
  });

  it('operates from the keyboard alone', async () => {
    const user = userEvent.setup();
    render(<Imports />);
    screen.getByRole('button', { name: 'Página 2' }).focus();
    await user.keyboard('{Enter}');
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');
  });
});
