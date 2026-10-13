import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@tanstack/react-table';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CellLabel } from '@/components/patterns/cell-label';
import { DataTable } from '@/components/patterns/data-table';
import { Badge } from '@/components/ui/badge';
import { render, screen, userEvent, waitFor, within } from '@/components/test-utils';

vi.mock('next/navigation', () => ({
  usePathname: () => '/portfolio',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

/**
 * SPEC-022 BR-022-18 / DS-67 — text that does not fit ends in an ellipsis even
 * when the cell holds a flex container (`Cluster`, `Stack`) or a badge.
 *
 * jsdom has no layout, but it does compute styles, so the stylesheet the cell
 * ships (`truncated-cell.css`) is loaded as-is and the question asked is the one
 * the browser answers: is `text-overflow: ellipsis` on the element that holds
 * the text? Whether the text really overflows is stubbed through `scrollWidth`.
 */
beforeAll(() => {
  const style = document.createElement('style');
  // The shipped stylesheet, read as text: the test runner stubs CSS imports.
  style.textContent = readFileSync(
    join(process.cwd(), 'src/components/patterns/truncated-cell.css'),
    'utf8',
  );
  document.head.append(style);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const LONG = 'Petróleo Brasileiro S.A. Petrobras — ações preferenciais';

type Row = { id: string };
const data: Row[] = [{ id: '1' }];

function table(cell: () => React.ReactNode, kind: 'text' | 'badge' = 'text') {
  const columns: ColumnDef<Row, unknown>[] = [
    { id: 'name', header: 'Ativo', meta: { kind }, cell },
  ];
  return <DataTable columns={columns} data={data} caption="Ativos" pagination={false} />;
}

const inTable = () => within(screen.getByRole('table'));
const ellipsisOf = (element: Element) => getComputedStyle(element).textOverflow;

describe('truncating text inside a flex container or a badge', () => {
  it('ends the name of a Cluster cell in an ellipsis, and keeps the badge beside it', () => {
    render(
      table(() => <CellLabel badge={<Badge variant="outline">Estimado</Badge>}>{LONG}</CellLabel>),
    );
    const name = inTable().getByText(LONG);
    expect(ellipsisOf(name)).toBe('ellipsis');
    expect(getComputedStyle(name).overflow).toBe('hidden');
    expect(getComputedStyle(name).whiteSpace).toBe('nowrap');
    // The cluster keeps its items on one line, so the badge is not pushed under a clipped name.
    expect(inTable().getByText('Estimado').closest('[data-slot="cluster"]')).toHaveClass(
      'flex-nowrap',
    );
  });

  it('ends the name of a Stack cell in an ellipsis, with the badge under it', () => {
    render(
      table(() => (
        <CellLabel layout="stacked" badge={<Badge variant="warning">Fora da tolerância</Badge>}>
          {LONG}
        </CellLabel>
      )),
    );
    expect(ellipsisOf(inTable().getByText(LONG))).toBe('ellipsis');
    expect(inTable().getByText(LONG).closest('[data-slot="stack"]')).not.toBeNull();
  });

  it('ends a badge wider than its column in an ellipsis, capped at the column', () => {
    render(table(() => <Badge dot>Não foi possível processar</Badge>, 'badge'));
    const badge = inTable()
      .getByText('Não foi possível processar')
      .closest<HTMLElement>('[data-slot="badge"]')!;
    expect(ellipsisOf(badge)).toBe('ellipsis');
    expect(getComputedStyle(badge).overflow).toBe('hidden');
    expect(getComputedStyle(badge).maxWidth).toBe('100%');
  });

  it('keeps the dot beside the text inside the truncating badge', () => {
    render(table(() => <Badge dot>Importado</Badge>, 'badge'));
    const dot = inTable().getByText('Importado').querySelector('[data-slot="badge-dot"]')!;
    expect(dot).not.toBeNull();
    expect(getComputedStyle(dot).display).toBe('inline-block');
  });

  it('leaves a badge outside a table cell at its natural width, with no ellipsis', () => {
    render(<Badge>Não foi possível processar</Badge>);
    const badge = screen.getByText('Não foi possível processar');
    expect(ellipsisOf(badge)).not.toBe('ellipsis');
    expect(getComputedStyle(badge).display).not.toBe('block');
  });

  it('lets the same text wrap in the card rendering instead of clipping it', () => {
    render(table(() => <CellLabel>{LONG}</CellLabel>));
    const card = screen.getByRole('list', { name: 'Ativos' });
    expect(ellipsisOf(within(card).getByText(LONG))).not.toBe('ellipsis');
  });

  it('opens the full text of a cell whose only overflow is inside a line it truncates itself', async () => {
    // The cell's own box fits (the line inside clips its own text), which is
    // exactly the case a measure of the outer box alone would miss.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('[data-cell-line]') ? 400 : 100;
    });
    const user = userEvent.setup();
    render(
      table(() => <CellLabel badge={<Badge variant="outline">Estimado</Badge>}>{LONG}</CellLabel>),
    );
    const cell = inTable().getByText(LONG).closest<HTMLElement>('[data-slot="table-cell-text"]')!;
    expect(cell).toHaveAttribute('tabindex', '0');

    await user.click(cell);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="popover-content"]')?.textContent).toBe(
        `${LONG} Estimado`,
      ),
    );
  });

  it('adds no tab stop when the line and the badge both fit', () => {
    render(
      table(() => <CellLabel badge={<Badge variant="outline">Estimado</Badge>}>XP</CellLabel>),
    );
    const cell = inTable().getByText('XP').closest('[data-slot="table-cell-text"]')!;
    expect(cell).not.toHaveAttribute('tabindex');
  });
});
