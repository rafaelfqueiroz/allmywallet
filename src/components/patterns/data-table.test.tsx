import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { Money as MoneyValue } from '@/core/shared/money';
import { columnWidth } from '@/components/patterns/data-table-columns';
import { MASKED_CURRENCY } from '@/i18n/masked';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

// The table mirrors its state into the URL with `history.replaceState` — never
// `router.replace`, which would refetch the page's server data (see the
// component's doc comment). A test drives the mirror through `search` and reads
// what was written off the `replaceState` spy; `replace` is there to be asserted
// untouched.
const nav = vi.hoisted(() => ({
  search: '',
  pathname: '/posicoes',
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const replaceState = vi.spyOn(window.history, 'replaceState');

beforeEach(() => {
  nav.search = '';
  nav.replace.mockClear();
  nav.push.mockClear();
  replaceState.mockClear();
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

  const lastReplace = () => replaceState.mock.lastCall?.[2] as string;
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

  it('opens on 10 rows per page with 10/25/50 on offer by default (BR-022-18)', () => {
    render(<DataTable columns={itemColumns} data={items} caption="Importações" />);
    const select = screen.getByRole('combobox', { name: 'Itens por página' });
    expect(select).toHaveValue('10');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['10', '25', '50']);
  });

  it('moves between pages with next, previous and the numbered buttons', async () => {
    const user = userEvent.setup();
    render(<Imports />);
    const pagination = screen.getByRole('navigation', { name: 'Paginação' });

    expect(within(pagination).getByRole('button', { name: 'Página anterior' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
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
    expect(within(pagination).getByRole('button', { name: 'Próxima página' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(within(pagination).getByRole('button', { name: 'Página anterior' }));
    expect(bodyNames()[0]).toBe('arquivo-06.xlsx');
  });

  it('keeps focus on next when it reaches the last page', async () => {
    const user = userEvent.setup();
    render(<Imports />);
    const pagination = screen.getByRole('navigation', { name: 'Paginação' });
    const next = within(pagination).getByRole('button', { name: 'Próxima página' });

    next.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(bodyNames()).toEqual(['arquivo-11.xlsx', 'arquivo-12.xlsx']);
    expect(next).toHaveFocus();

    // Pressing it again at the end does nothing.
    await user.keyboard('{Enter}');
    expect(bodyNames()).toEqual(['arquivo-11.xlsx', 'arquivo-12.xlsx']);
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

  it('writes the filter text to the URL, resetting the page and keeping other parameters', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2&wallet=abc';
    render(<Imports />);

    await user.type(screen.getByRole('searchbox'), '12');

    expect(writtenParams().get('q')).toBe('12');
    expect(writtenParams().has('page')).toBe(false);
    // Parameters the table does not own are left alone.
    expect(writtenParams().get('wallet')).toBe('abc');
  });

  // The rows are already loaded: a sort, page, size or filter change must not
  // go to the server, which `router.replace` would.
  it('mirrors every state change with history.replaceState and never with the router', async () => {
    const user = userEvent.setup();
    // What Next leaves on its own entries; jsdom's default `null` would make
    // the assertion below pass whatever the component passed.
    window.history.replaceState({ __NA: true }, '');
    replaceState.mockClear();
    render(<Imports />);

    await user.click(screen.getByRole('button', { name: 'Ordenar por Arquivo' }));
    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Itens por página' }), '10');
    await user.type(screen.getByRole('searchbox'), 'a');

    expect(replaceState).toHaveBeenCalledTimes(4);
    expect(nav.replace).not.toHaveBeenCalled();
    // Never Next's own history state back: it carries the marker that makes
    // Next skip syncing `useSearchParams` (tests/e2e/data-table.spec.ts).
    for (const call of replaceState.mock.calls) expect(call[0]).toBeNull();
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

/**
 * Server-paged mode (#214): the rows are one page the server already sorted
 * and paged — the transaction ledger, 10.000+ rows (SPEC-006 BR-006-07). The
 * URL is the only state, so every control is a link or a navigation, and the
 * table never re-orders or slices what it was handed.
 */
describe('DataTable — server-paged', () => {
  type Entry = { id: string; code: string; total: string };

  // Deliberately not in code order: the server chose this order.
  const page2: Entry[] = [
    { id: 'a', code: 'VALE3', total: '30' },
    { id: 'b', code: 'ABEV3', total: '10' },
  ];

  const entryColumns: ColumnDef<Entry, unknown>[] = [
    { id: 'code', header: 'Ativo', cell: ({ row }) => row.original.code },
    { id: 'kind', header: 'Tipo', enableSorting: false, cell: () => 'Compra' },
    {
      id: 'total',
      header: 'Total',
      meta: { kind: 'money' },
      cell: ({ row }) => row.original.total,
    },
  ];

  function Ledger({ data = page2, total = 27 }: { data?: Entry[]; total?: number }) {
    return (
      <DataTable
        columns={entryColumns}
        data={data}
        server={{ total, rowId: (row) => row.id }}
        caption="Transações"
        sortable
        initialSorting={[{ id: 'code', desc: true }]}
        sortLabel={(column) => `Ordenar por ${column}`}
        pageSizeOptions={[25, 50]}
        defaultPageSize={25}
        itemNoun="transações"
        toolbar={<span>barra de filtros</span>}
        noResults={<EmptyState title="Nada com esses filtros" />}
      />
    );
  }

  const bodyCodes = () =>
    within(screen.getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

  it('renders the rows in the order the server sent, and counts the server total', () => {
    nav.search = 'page=2&type=buy';
    render(<Ledger />);
    expect(bodyCodes()).toEqual(['VALE3', 'ABEV3']);
    expect(screen.getByText('Mostrando 26–27 de 27 transações')).toBeInTheDocument();
  });

  it('makes sort headers links that keep the other parameters and drop the page', () => {
    nav.search = 'page=2&type=buy';
    render(<Ledger />);
    const table = screen.getByRole('table');
    // The open sort is code descending, so pressing it asks for ascending.
    expect(within(table).getByRole('link', { name: 'Ordenar por Ativo' })).toHaveAttribute(
      'href',
      '/posicoes?type=buy&sort=code%3Aasc',
    );
    // Another column starts ascending.
    expect(within(table).getByRole('link', { name: 'Ordenar por Total' })).toHaveAttribute(
      'href',
      '/posicoes?type=buy&sort=total%3Aasc',
    );
    expect(within(table).getByRole('columnheader', { name: 'Ordenar por Ativo' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('leaves a column that opted out of sorting as plain text, and keeps it out of the URL', () => {
    nav.search = 'sort=kind%3Aasc';
    render(<Ledger />);
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('link', { name: /Tipo/ })).not.toBeInTheDocument();
    // An unsortable id in the URL falls back to the default sort.
    expect(within(table).getByRole('columnheader', { name: 'Ordenar por Ativo' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('aligns a figures column right, header and cells', () => {
    render(<Ledger />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')[2]?.className).toContain('text-right');
    expect(within(table).getAllByRole('cell')[2]?.className).toContain('text-right');
    expect(within(table).getAllByRole('cell')[0]?.className).not.toContain('text-right');
  });

  it('pages with links to the same URL, marking the current page', () => {
    nav.search = 'page=2&type=buy';
    render(<Ledger />);
    const pager = screen.getByRole('navigation', { name: 'Paginação' });
    expect(within(pager).getByRole('link', { name: 'Página 1' })).toHaveAttribute(
      'href',
      '/posicoes?type=buy',
    );
    expect(within(pager).getByRole('link', { name: 'Página 2' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pager).getByRole('link', { name: 'Página anterior' })).toHaveAttribute(
      'href',
      '/posicoes?type=buy',
    );
    // The last page has no next: an aria-disabled button, not a link to nowhere.
    expect(within(pager).queryByRole('link', { name: 'Próxima página' })).not.toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: 'Próxima página' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('navigates on a page-size change, back to page 1, and never mirrors locally', async () => {
    const user = userEvent.setup();
    nav.search = 'page=2&type=buy';
    render(<Ledger />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Itens por página' }), '50');
    expect(nav.push).toHaveBeenCalledWith('/posicoes?type=buy&size=50');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('keeps the toolbar and shows the no-results state when the server matched nothing', () => {
    render(<Ledger data={[]} total={0} />);
    expect(screen.getByText('barra de filtros')).toBeInTheDocument();
    expect(screen.getByText('Nada com esses filtros')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  /** #214 review F1 — a navigation keeps this mounted; a tick must not move rows. */
  it('does not carry a ticked row onto the transaction that takes its place', async () => {
    const user = userEvent.setup();
    const withBox: ColumnDef<Entry, unknown>[] = [
      {
        id: 'select',
        header: 'Selecionar',
        cell: ({ row }) => (
          <input
            type="checkbox"
            name="selected"
            value={row.original.id}
            aria-label={row.original.code}
          />
        ),
      },
      ...entryColumns,
    ];
    const table = (data: Entry[]) => (
      <DataTable
        columns={withBox}
        data={data}
        server={{ total: 4, rowId: (row) => row.id }}
        caption="Transações"
        pageSizeOptions={[2]}
        defaultPageSize={2}
      />
    );
    const { rerender } = render(table(page2));
    await user.click(within(screen.getByRole('table')).getByRole('checkbox', { name: 'ABEV3' }));

    rerender(
      table([
        { id: 'c', code: 'ITSA4', total: '5' },
        { id: 'd', code: 'WEGE3', total: '1' },
      ]),
    );
    const ticked = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="selected"]:checked'),
    ).map((box) => box.value);
    expect(ticked).toEqual([]);
  });

  it('shows the default order when the sort was cleared, since the query has one', () => {
    nav.search = 'sort=';
    render(<Ledger />);
    expect(
      within(screen.getByRole('table')).getByRole('columnheader', { name: 'Ordenar por Ativo' }),
    ).toHaveAttribute('aria-sort', 'descending');
  });

  it('has no axe violations', async () => {
    nav.search = 'page=2';
    const { container } = render(<Ledger />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

/**
 * SPEC-022 BR-022-18 / DL-022-17 — a column is its *kind*: alignment, width and
 * truncation follow from it, and never from what the cells hold.
 */
describe('DataTable — column kinds', () => {
  type Wide = Record<string, string>;
  const KINDS = ['text', 'date', 'badge', 'number', 'money', 'percent', 'control'] as const;
  const wideRow: Wide = Object.fromEntries(KINDS.map((kind) => [kind, `${kind}-valor`]));

  const kindColumns: ColumnDef<Wide, unknown>[] = KINDS.map((kind) => ({
    id: kind,
    header: `cab-${kind}`,
    meta: { kind },
    cell: ({ row }) => row.original[kind],
  }));

  const tableOf = () => screen.getByRole('table');
  const headerOf = (kind: string) =>
    within(tableOf()).getByRole('columnheader', { name: `cab-${kind}` });
  const cellOf = (kind: string) => within(tableOf()).getByRole('cell', { name: `${kind}-valor` });

  function renderKinds() {
    return render(
      <DataTable columns={kindColumns} data={[wideRow]} caption="Tipos" pagination={false} />,
    );
  }

  it.each([
    ['text', false],
    ['date', false],
    ['badge', false],
    ['number', true],
    ['money', true],
    ['percent', true],
    ['control', false],
  ] as const)('%s: header and cell sit %s', (kind, right) => {
    renderKinds();
    // Right is text-right on both; left is the absence of it, never a stray class.
    expect(headerOf(kind).className.includes('text-right')).toBe(right);
    expect(cellOf(kind).className.includes('text-right')).toBe(right);
    // Figures read down their decimal point (DS-13).
    expect(cellOf(kind).className.includes('tabular-nums')).toBe(right);
  });

  it('treats a column with no kind as text', () => {
    render(
      <DataTable
        columns={[{ id: 'a', header: 'Livre', cell: () => 'x' }]}
        data={[wideRow]}
        caption="Sem tipo"
        pagination={false}
      />,
    );
    expect(within(tableOf()).getByRole('columnheader').className).not.toContain('text-right');
    expect(within(tableOf()).getByRole('cell').className).not.toContain('text-right');
  });

  it('lays the table out fixed, with one <col> per column carrying the defined width', () => {
    renderKinds();
    expect(tableOf().className).toContain('table-fixed');
    const cols = Array.from(tableOf().querySelectorAll<HTMLTableColElement>('colgroup > col'));
    expect(cols).toHaveLength(KINDS.length);
    // Default widths are the kind's own: the figure columns in `ch`, so they do
    // not depend on the digits shown, and a control a fixed length.
    const widths = cols.map((col) => col.style.width);
    expect(widths[KINDS.indexOf('money')]).toBe('calc(19ch + 1rem)');
    expect(widths[KINDS.indexOf('number')]).toBe('calc(14ch + 1rem)');
    expect(widths[KINDS.indexOf('control')]).toBe('3rem');
    expect(widths.every((width) => width !== '')).toBe(true);
  });

  it('sizes the money column for thirteen digits and the mask, whatever the figures are', () => {
    // 'R$ 12.345.678.901,23' measures ~17.3ch in the app's font (its separators
    // are narrower than a digit) and a sign makes 18; the mask is 9 characters.
    // The real-browser check is the 13-digit E2E in tests/e2e/transactions.spec.ts.
    const widest = 18;
    const [, ch] = /calc\((\d+)ch/.exec(columnWidth('money')) ?? [];
    expect(Number(ch)).toBeGreaterThanOrEqual(widest);
    expect(Number(ch)).toBeGreaterThan(MASKED_CURRENCY.length);
  });

  it('takes a column width from its definition, in characters or as a CSS length', () => {
    render(
      <DataTable
        columns={[
          { id: 'a', header: 'A', meta: { kind: 'text', width: 40 }, cell: () => 'x' },
          { id: 'b', header: 'B', meta: { kind: 'number', width: '6rem' }, cell: () => '1' },
        ]}
        data={[wideRow]}
        caption="Larguras"
        pagination={false}
      />,
    );
    const cols = Array.from(tableOf().querySelectorAll<HTMLTableColElement>('colgroup > col'));
    expect(cols.map((col) => col.style.width)).toEqual(['calc(40ch + 1rem)', '6rem']);
  });

  it('gives hidden amounts the width of visible ones: the columns do not depend on the cells', () => {
    const money: ColumnDef<{ value: string }, unknown>[] = [
      {
        id: 'value',
        header: 'Valor',
        meta: { kind: 'money' },
        cell: ({ row }) => row.original.value,
      },
    ];
    const widthFor = (value: string) => {
      const { unmount } = render(
        <DataTable columns={money} data={[{ value }]} caption="Valores" pagination={false} />,
      );
      const width = tableOf().querySelector<HTMLTableColElement>('col')?.style.width;
      unmount();
      return width;
    };
    expect(widthFor('R$ 1,00')).toBe(widthFor(MASKED_CURRENCY));
    expect(widthFor('R$ 1,00')).toBe(widthFor('R$ 12.345.678.901,23'));
  });

  it('truncates text, dates and badges, and never a figure or a control', () => {
    renderKinds();
    for (const kind of ['text', 'date', 'badge']) {
      expect(cellOf(kind).querySelector('[data-slot="table-cell-text"]')).not.toBeNull();
    }
    for (const kind of ['number', 'money', 'percent', 'control']) {
      expect(cellOf(kind).querySelector('[data-slot="table-cell-text"]')).toBeNull();
    }
  });

  it('keeps the card rendering as flat rows under hairlines, never a card (BR-022-36)', () => {
    renderKinds();
    const list = screen.getByRole('list', { name: 'Tipos' });
    expect(list.className).toContain('divide-y');
    expect(list.querySelector('[data-slot="card"]')).toBeNull();
  });
});

/**
 * SPEC-022 BR-022-18 — text that does not fit ends in an ellipsis, and its full
 * text opens on hover, keyboard focus and tap. jsdom has no layout, so which
 * cells overflow is stubbed through `scrollWidth`.
 */
describe('DataTable — truncated text', () => {
  const LONG = 'INTER DISTRIBUIDORA DE TÍTULOS E VALORES MOBILIÁRIOS LTDA';
  type Broker = { id: string; name: string };
  const data: Broker[] = [
    { id: '1', name: LONG },
    { id: '2', name: 'XP' },
  ];

  function brokers(cell?: (row: Broker) => React.ReactNode) {
    const columns: ColumnDef<Broker, unknown>[] = [
      {
        id: 'name',
        header: 'Instituição',
        meta: { kind: 'text' },
        cell: ({ row }) => cell?.(row.original) ?? row.original.name,
      },
    ];
    return <DataTable columns={columns} data={data} caption="Instituições" pagination={false} />;
  }

  /** The cell whose own text is `LONG` overflows its 100px box; nothing else does. */
  function overflowLong() {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('[data-slot="table-cell-text"]') && this.textContent === LONG ? 400 : 100;
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    replaceState.mockClear();
  });

  const tipText = () => document.querySelector('[data-slot="popover-content"]')?.textContent;
  const cellText = (text: string) =>
    within(screen.getByRole('table'))
      .getByText(text)
      .closest<HTMLElement>('[data-slot="table-cell-text"]')!;

  it('opens the full text on keyboard focus', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers());
    expect(tipText()).toBeUndefined();

    await user.tab(); // the table's own scroll region
    await user.tab(); // the truncated cell
    expect(cellText(LONG)).toHaveFocus();
    await waitFor(() => expect(tipText()).toBe(LONG));
  });

  it('opens the full text on hover, and closes it after the pointer leaves', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers());
    await user.hover(cellText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG));

    await user.unhover(cellText(LONG));
    await waitFor(() => expect(tipText()).toBeUndefined());
  });

  it('opens the full text on tap, and a second tap does not slam it shut', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers());
    await user.click(cellText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG));
    await user.click(cellText(LONG));
    expect(tipText()).toBe(LONG);
  });

  it('closes on Escape', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers());
    await user.click(cellText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tipText()).toBeUndefined());
  });

  it('makes only the cell that overflows a tab stop', () => {
    overflowLong();
    render(brokers());
    expect(cellText(LONG)).toHaveAttribute('tabindex', '0');
    // Text that fits is fully visible: nothing to reveal, nothing to tab to.
    expect(cellText('XP')).not.toHaveAttribute('tabindex');
  });

  it('adds no tab stop and no popover when nothing overflows', async () => {
    const user = userEvent.setup();
    render(brokers());
    expect(within(screen.getByRole('table')).queryByRole('link')).toBeNull();
    expect(cellText(LONG)).not.toHaveAttribute('tabindex');
    await user.hover(cellText(LONG));
    await user.click(cellText(LONG));
    expect(tipText()).toBeUndefined();
  });

  it('leaves a link in a truncated cell as the focus target, and opens the text on its focus', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers((row) => <a href={`/instituicoes/${row.id}`}>{row.name}</a>));
    // The cell is not a second tab stop beside its own link.
    expect(cellText(LONG)).not.toHaveAttribute('tabindex');

    await user.tab(); // the table's scroll region
    await user.tab(); // the link
    expect(within(screen.getByRole('table')).getAllByRole('link')[0]).toHaveFocus();
    await waitFor(() => expect(tipText()).toBe(LONG));
  });

  it('keeps the full text in the cell for a screen reader, and hides the popover copy', async () => {
    overflowLong();
    const user = userEvent.setup();
    render(brokers());
    expect(within(screen.getByRole('table')).getByRole('cell', { name: LONG })).toBeInTheDocument();
    await user.click(cellText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG));
    expect(document.querySelector('[data-slot="popover-content"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('reads two stacked lines as separate words in the popover', async () => {
    const user = userEvent.setup();
    const stacked = (
      <DataTable
        columns={[
          {
            id: 'name',
            header: 'Ativo',
            meta: { kind: 'text' },
            cell: () => (
              <div>
                <span>PETR4</span>
                <span>Petróleo</span>
              </div>
            ),
          },
        ]}
        data={[{ id: '1', name: 'x' }]}
        caption="Ativos"
        pagination={false}
      />
    );
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(10);
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(50);
    render(stacked);
    await user.click(document.querySelector('[data-slot="table-cell-text"]')!);
    await waitFor(() => expect(tipText()).toBe('PETR4 Petróleo'));
  });

  it('has no axe violations with an open tip', async () => {
    overflowLong();
    const user = userEvent.setup();
    const { container } = render(brokers());
    await user.click(cellText(LONG));
    await waitFor(() => expect(tipText()).toBe(LONG));
    expect(await audit(container)).toHaveNoViolations();
  });
});
