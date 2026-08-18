import { describe, expect, it } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/patterns/data-table';
import { EmptyState } from '@/components/patterns/empty-state';
import { Money } from '@/components/patterns/money';
import { Money as MoneyValue } from '@/core/shared/money';
import { audit, render, screen, userEvent, within } from '@/components/test-utils';

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
