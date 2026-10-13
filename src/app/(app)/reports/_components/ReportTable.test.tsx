import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from '@/components/patterns/empty-state';
import { audit, render, screen, userEvent, within } from '@/components/test-utils';
import {
  ReportTable,
  type ReportColumn,
  type ReportRow,
  type ReportTableLabels,
} from '@/app/(app)/reports/_components/ReportTable';

/**
 * SPEC-022 BR-022-18 — the Relatórios tables on the table standard — and
 * SPEC-016 BR-016-16, the table that carries what a chart only draws.
 *
 * The table mirrors its state into the URL with `history.replaceState`; a test
 * drives the URL through `nav.search` and reads what was written back.
 */
const nav = vi.hoisted(() => ({ search: '' }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const replaceState = vi.spyOn(window.history, 'replaceState');

beforeEach(() => {
  nav.search = '';
  replaceState.mockClear();
});

const labels: ReportTableLabels = {
  caption: 'Valores do gráfico',
  sortBy: 'Ordenar por {column}',
  sortField: 'Ordenar por',
  sortAscending: 'Ordem crescente',
  sortDescending: 'Ordem decrescente',
  itemNoun: 'datas',
  empty: <EmptyState title="Nada para mostrar neste período" />,
  filterPlaceholder: 'Filtrar por ativo',
};

const columns: ReportColumn[] = [
  { id: 'asset', header: 'Ativo', kind: 'text' },
  { id: 'value', header: 'Valor', kind: 'money' },
];

/** The cells arrive rendered; the rank is what the column sorts by. */
function row(asset: string, text: string, rank: number | undefined): ReportRow {
  return { cells: { asset, value: text }, sort: { asset, value: rank } };
}

// "R$ 9,00" sorts before "R$ 100,00" by figure and after it as text — the case a
// lexical sort gets wrong.
const rows: ReportRow[] = [
  row('PETR4', 'R$ 100,00', 1),
  row('VALE3', 'R$ 9,00', 0),
  row('ITSA4', 'R$ 250,00', 2),
];

function table(props: Partial<Parameters<typeof ReportTable>[0]> = {}) {
  return (
    <ReportTable
      columns={columns}
      rows={rows}
      labels={labels}
      paramPrefix="history"
      initialSort={{ id: 'asset', desc: false }}
      {...props}
    />
  );
}

/** The ticker of each body row on screen, in order. */
function order(): string[] {
  const body = within(screen.getByRole('table', { name: 'Valores do gráfico' })).getAllByRole('row');
  return body.slice(1).map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '');
}

describe('ReportTable', () => {
  it('shows every figure as text in a table named for what it carries', () => {
    render(table());
    expect(order()).toEqual(['ITSA4', 'PETR4', 'VALE3']);
    const grid = screen.getByRole('table', { name: 'Valores do gráfico' });
    expect(within(grid).getByText('R$ 250,00')).toBeInTheDocument();
  });

  it('opens on the sort the table declares', () => {
    render(table({ initialSort: { id: 'asset', desc: true } }));
    expect(order()).toEqual(['VALE3', 'PETR4', 'ITSA4']);
  });

  it('sorts a figure by its value, not by how it reads as text', async () => {
    const user = userEvent.setup();
    render(table());
    await user.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    // A figure's first click is largest first.
    expect(order()).toEqual(['ITSA4', 'PETR4', 'VALE3']);
    await user.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    // R$ 9,00 first, though "R$ 9" sorts after "R$ 1" as text.
    expect(order()).toEqual(['VALE3', 'PETR4', 'ITSA4']);
  });

  it('keeps a figure that does not exist at the bottom in both directions', async () => {
    const user = userEvent.setup();
    render(table({ rows: [...rows, row('NOVO11', '—', undefined)] }));
    await user.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    expect(order().at(-1)).toBe('NOVO11');
    await user.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    expect(order().at(-1)).toBe('NOVO11');
  });

  it('marks the sorted column for assistive technology', () => {
    render(table());
    expect(screen.getByRole('columnheader', { name: /Ativo/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('pages ten to a page, with the page size and the position in the URL', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 23 }, (_, index) =>
      row(`ATIVO${String(index + 1).padStart(2, '0')}`, 'R$ 1,00', index),
    );
    render(table({ rows: many }));

    expect(order()).toHaveLength(10);
    expect(screen.getByText('Mostrando 1–10 de 23 datas')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByText('Mostrando 11–20 de 23 datas')).toBeInTheDocument();
    expect(String(replaceState.mock.lastCall?.[2])).toContain('history_page=2');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Itens por página' }), '25');
    expect(order()).toHaveLength(23);
    expect(String(replaceState.mock.lastCall?.[2])).toContain('history_size=25');
  });

  it('keeps two tables on one page apart by their prefix', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 23 }, (_, index) => row(`A${index + 10}`, 'R$ 1,00', index));
    render(table({ rows: many, paramPrefix: 'monthly' }));
    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    const written = String(replaceState.mock.lastCall?.[2]);
    expect(written).toContain('monthly_page=2');
    expect(written).not.toContain('history_page');
  });

  it('filters by the text columns when it is searchable', async () => {
    const user = userEvent.setup();
    render(table({ searchable: true }));
    await user.type(screen.getByRole('searchbox', { name: 'Filtrar a tabela' }), 'vale');
    expect(order()).toEqual(['VALE3']);
  });

  it('has no filter unless the table asks for one', () => {
    render(table());
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('closes with the total of the whole collection, on every page', () => {
    const many = Array.from({ length: 23 }, (_, index) => row(`A${index + 10}`, 'R$ 1,00', index));
    render(table({ rows: many, totals: { label: 'Total', cells: { value: 'R$ 23,00' } } }));
    const grid = screen.getByRole('table', { name: 'Valores do gráfico' });
    expect(within(grid).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    expect(within(grid).getByRole('cell', { name: 'R$ 23,00' })).toBeInTheDocument();
  });

  it('says so when there is nothing to show, instead of an empty table', () => {
    render(table({ rows: [] }));
    expect(screen.getByText('Nada para mostrar neste período')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('puts the figures in a right-aligned column, in tabular digits', () => {
    render(table());
    const grid = screen.getByRole('table', { name: 'Valores do gráfico' });
    expect(within(grid).getByRole('columnheader', { name: /Valor/ })).toHaveClass('text-right');
    expect(within(grid).getByText('R$ 250,00').closest('td')).toHaveClass('tabular-nums');
  });

  it('has no axe violations', async () => {
    const { container } = render(table({ searchable: true }));
    expect(await audit(container)).toHaveNoViolations();
  });
});
