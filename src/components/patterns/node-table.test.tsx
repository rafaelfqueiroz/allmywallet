import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeTable, type NodeColumn, type NodeRow } from '@/components/patterns/node-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

const nav = vi.hoisted(() => ({ search: '', pathname: '/settings/watch' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const replaceState = vi.spyOn(window.history, 'replaceState');

beforeEach(() => {
  nav.search = '';
  replaceState.mockClear();
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

const columns: NodeColumn[] = [
  { id: 'asset', header: 'Ativo', kind: 'text', sortable: true },
  { id: 'value', header: 'Valor', kind: 'money', sortable: true },
  { id: 'actions', header: 'Ações', kind: 'control', srOnlyHeader: true },
];

/**
 * The cells arrive finished, as a Server Component hands them over: the amount
 * is text the server formatted, and the sort key is a **rank**, never the
 * figure. R$ 1.000,00 ranks below R$ 90,00 only if somebody sorted it as text,
 * which is the defect these keys exist to make impossible.
 */
function row(index: number, value: string, rank: number | undefined): NodeRow {
  const code = `ATV${String(index).padStart(2, '0')}`;
  return {
    id: code,
    anchor: `regra-${code}`,
    keys: { asset: code, ...(rank === undefined ? {} : { value: rank }) },
    cells: {
      asset: code,
      value,
      actions: (
        <button type="submit" form={`mute-${code}`} aria-label={`Silenciar ${code}`}>
          x
        </button>
      ),
    },
  };
}

const few: NodeRow[] = [
  row(1, 'R$ 90,00', 0),
  row(2, 'R$ 1.000,00', 1),
  row(3, 'R$ 12,00', undefined),
];

function many(count: number): NodeRow[] {
  return Array.from({ length: count }, (_, index) => row(index + 1, 'R$ 1,00', index));
}

function Table(props: Partial<Parameters<typeof NodeTable>[0]> = {}) {
  return (
    <NodeTable
      columns={columns}
      rows={few}
      caption="Regras"
      noun="regras"
      filterPlaceholder="Buscar ativo"
      {...props}
    />
  );
}

function codesInTable(): string[] {
  const table = screen.getByRole('table', { name: 'Regras' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((entry) => within(entry).getAllByRole('cell')[0]?.textContent ?? '');
}

describe('NodeTable', () => {
  it('renders every cell as the server rendered it, under its own header', () => {
    render(<Table />);
    const table = screen.getByRole('table', { name: 'Regras' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Ativo', 'Valor', 'Ações']);
    expect(within(table).getByText('R$ 1.000,00')).toBeInTheDocument();
  });

  it('orders a figure column by its rank, not by the text of the figure', async () => {
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    // Largest first on a figure column; the row with no figure stays last.
    expect(codesInTable()).toEqual(['ATV02', 'ATV01', 'ATV03']);
    await userEvent.click(screen.getByRole('button', { name: 'Ordenar por Valor' }));
    expect(codesInTable()).toEqual(['ATV01', 'ATV02', 'ATV03']);
  });

  it('sorts text by pt-BR collation: an accented initial is not after Z', async () => {
    const named = (code: string): NodeRow => ({
      id: code,
      keys: { asset: code },
      cells: { asset: code, value: 'R$ 1,00', actions: null },
    });
    render(<Table rows={['Varejo', 'Água e Saneamento', 'Zeta'].map(named)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ordenar por Ativo' }));
    expect(codesInTable()).toEqual(['Água e Saneamento', 'Varejo', 'Zeta']);
    await userEvent.click(screen.getByRole('button', { name: 'Ordenar por Ativo' }));
    expect(codesInTable()).toEqual(['Zeta', 'Varejo', 'Água e Saneamento']);
  });

  it('sorts an absent figure last in both directions: absence is not zero', async () => {
    render(<Table />);
    const button = screen.getByRole('button', { name: 'Ordenar por Valor' });
    await userEvent.click(button);
    expect(codesInTable().at(-1)).toBe('ATV03');
    await userEvent.click(button);
    expect(codesInTable().at(-1)).toBe('ATV03');
  });

  it('filters by the string keys and says when nothing matches', async () => {
    render(<Table />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filtrar a tabela' }), 'atv02');
    expect(codesInTable()).toEqual(['ATV02']);
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('Nenhum resultado para este filtro')).toBeInTheDocument();
  });

  it('pages ten rows at a time and counts them with the noun it was given', () => {
    render(<Table rows={many(23)} />);
    expect(codesInTable()).toHaveLength(10);
    expect(screen.getByText('Mostrando 1–10 de 23 regras')).toBeInTheDocument();
  });

  it('keeps the page size in the URL under its own prefix', async () => {
    render(<Table rows={many(23)} paramPrefix="rules" />);
    await userEvent.selectOptions(screen.getByLabelText('Itens por página'), '25');
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/settings/watch?rules_size=25');
  });

  it('opens on the sort the page declares, and marks that column for assistive technology', () => {
    render(<Table sort={{ id: 'asset', desc: true }} />);
    expect(codesInTable()).toEqual(['ATV03', 'ATV02', 'ATV01']);
    expect(screen.getByRole('columnheader', { name: /Ativo/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('keeps the position in the URL under the table’s prefix, apart from another table’s', async () => {
    render(<Table rows={many(23)} paramPrefix="monthly" />);
    await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByText('Mostrando 11–20 de 23 regras')).toBeInTheDocument();
    const written = String(replaceState.mock.lastCall?.[2]);
    expect(written).toContain('monthly_page=2');
    expect(written).not.toContain('history_page');
  });

  it('has no filter unless the page gives it something to say', () => {
    render(<NodeTable columns={columns} rows={few} caption="Regras" noun="regras" />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('puts the figures in a right-aligned column, in tabular digits', () => {
    render(<Table />);
    const table = screen.getByRole('table', { name: 'Regras' });
    expect(within(table).getByRole('columnheader', { name: /Valor/ })).toHaveClass('text-right');
    expect(within(table).getByText('R$ 1.000,00').closest('td')).toHaveClass('tabular-nums');
  });

  it('shows the caller’s empty state when there is nothing to list', () => {
    render(<Table rows={[]} empty={<EmptyState title="Nenhuma regra ainda" />} />);
    expect(screen.getByText('Nenhuma regra ainda')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('leaves a bounded list without a pager when it opts out', () => {
    render(<Table rows={many(12)} pagination={false} />);
    expect(codesInTable()).toHaveLength(12);
    expect(screen.queryByLabelText('Itens por página')).not.toBeInTheDocument();
  });

  it('pins the totals under the rows, whatever the page, and as a card below md', () => {
    render(
      <Table
        rows={many(23)}
        totals={{ label: 'Total da carteira', cells: { value: 'R$ 23,00' } }}
      />,
    );
    const table = screen.getByRole('table', { name: 'Regras' });
    expect(within(table).getByRole('rowheader', { name: 'Total da carteira' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'R$ 23,00' })).toBeInTheDocument();
    // The card under the list names each figure by its column.
    expect(screen.getByText('Total da carteira', { selector: 'p' })).toBeInTheDocument();
  });

  it('has no axe violations with a pinned total and its card', async () => {
    const { container } = render(
      <Table totals={{ label: 'Total', cells: { value: 'R$ 1.102,00' } }} />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });

  it('keeps a row control outside any form: the button names its form by attribute', () => {
    const { container } = render(<Table />);
    // DS-28 renders each cell twice, so a form in a cell would post twice.
    expect(container.querySelectorAll('form')).toHaveLength(0);
    const button = screen.getAllByRole('button', { name: 'Silenciar ATV01' })[0];
    expect(button).toHaveAttribute('form', 'mute-ATV01');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Table rows={many(12)} />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('NodeTable — deep links to a row (SPEC-022 BR-022-07)', () => {
  it('gives the table row the anchor and the card its own id, so no id repeats', () => {
    const { container } = render(<Table />);
    expect(container.querySelectorAll('[id="regra-ATV01"]')).toHaveLength(1);
    expect(container.querySelectorAll('[id="regra-ATV01-card"]')).toHaveLength(1);
    expect(container.querySelector('tr#regra-ATV01')).not.toBeNull();
  });

  it('pages to the row a link names when it is not on the first page, and marks it', async () => {
    window.location.hash = '#regra-ATV15';
    const { container } = render(<Table rows={many(23)} />);
    await waitFor(() => expect(codesInTable()).toContain('ATV15'));
    expect(screen.getByText('Mostrando 11–20 de 23 regras')).toBeInTheDocument();
    expect(container.querySelector('tr#regra-ATV15')).toHaveAttribute('data-linked');
    expect(container.querySelector('[id="regra-ATV01"]')).toBeNull();
  });

  it('does not pull the reader back to the linked row when they page away', async () => {
    window.location.hash = '#regra-ATV15';
    render(<Table rows={many(23)} />);
    await waitFor(() => expect(codesInTable()).toContain('ATV15'));
    await userEvent.click(screen.getByRole('button', { name: 'Página 1' }));
    expect(codesInTable()).toContain('ATV01');
    expect(codesInTable()).not.toContain('ATV15');
  });

  it('marks nothing for a hash that names no row', () => {
    window.location.hash = '#regra-INEXISTENTE';
    const { container } = render(<Table />);
    expect(container.querySelector('[data-linked]')).toBeNull();
  });
});

/**
 * SPEC-022 BR-022-18, DS-66 (#237) — the import batch's row tables: server-paged
 * pages of rows whose cells hold forms, rendered once.
 */
describe('NodeTable — server-paged, without a card copy', () => {
  const formColumns: NodeColumn[] = [
    { id: 'asset', header: 'Ativo', kind: 'text' },
    { id: 'action', header: 'Ação', kind: 'control' },
  ];

  /** One page of the batch's rows: a form in each, as the page renders them. */
  function page(from: number, count: number): NodeRow[] {
    return Array.from({ length: count }, (_, index) => {
      const code = `ATV${String(from + index).padStart(2, '0')}`;
      return {
        id: code,
        cells: {
          asset: code,
          action: (
            <form>
              <label htmlFor={`classify-${code}`}>Classificar como</label>
              <input id={`classify-${code}`} name="type" />
              <button type="submit">Classificar</button>
            </form>
          ),
        },
      };
    });
  }

  function Server({ size = '10', pageNumber = '2' }: { size?: string; pageNumber?: string }) {
    nav.search = `atencao_page=${pageNumber}&atencao_size=${size}&resumo_page=3`;
    return (
      <NodeTable
        columns={formColumns}
        rows={page(11, 10)}
        caption="Precisa de atenção"
        noun="linhas"
        paramPrefix="atencao"
        server={{ total: 60 }}
        cards={false}
        linkHash="attention"
      />
    );
  }

  it('counts the whole batch, not the page it was handed', () => {
    render(<Server />);
    expect(screen.getByText('Mostrando 11–20 de 60 linhas')).toBeInTheDocument();
  });

  it('renders a form once: no hidden copy repeats its ids or its field names', () => {
    const { container } = render(<Server />);
    expect(container.querySelectorAll('form')).toHaveLength(10);
    expect(container.querySelectorAll('[id="classify-ATV11"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="data-table"] ul')).toBeNull();
    // Both the label and its input are reachable by name: the label points at the right input.
    expect(screen.getAllByLabelText('Classificar como')).toHaveLength(10);
  });

  it('pages with links that keep this table’s prefix, the other tables’ places, and end at the table', () => {
    render(<Server />);
    const pager = screen.getByRole('navigation', { name: 'Paginação' });
    const next = within(pager).getByRole('link', { name: 'Próxima página' });
    expect(next).toHaveAttribute('href', '/settings/watch?atencao_page=3&resumo_page=3#attention');
    // Back to page 1 drops the default, as every table does; the other table stays.
    const first = within(pager).getByRole('link', { name: 'Página 1' });
    expect(first).toHaveAttribute('href', '/settings/watch?resumo_page=3#attention');
  });

  it('offers 10, 25 and 50, and shows the size the URL holds', () => {
    render(<Server size="25" />);
    const select = screen.getByLabelText('Itens por página');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['10', '25', '50']);
    expect(select).toHaveValue('25');
  });

  it('has no sort control: the page arrives in the server’s order', () => {
    render(<Server />);
    expect(screen.queryByRole('button', { name: /Ordenar por/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Ordenar por/ })).toBeNull();
  });

  it('has no axe violations with forms in the cells', async () => {
    const { container } = render(<Server />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
