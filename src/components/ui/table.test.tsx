import { describe, expect, it } from 'vitest';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableColGroup,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { audit, render, screen } from '@/components/test-utils';

function Posicoes() {
  return (
    <Table>
      <TableCaption>Posições</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Ativo</TableHead>
          <TableHead scope="col">Quantidade</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>PETR4</TableCell>
          <TableCell className="tabular-nums">100</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="tabular-nums">100</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

describe('Table', () => {
  it('exposes real table semantics, not a grid of divs', () => {
    render(<Posicoes />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('cell', { name: 'PETR4' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Total' })).toBeInTheDocument();
  });

  it('is named by its caption', () => {
    render(<Posicoes />);
    expect(screen.getByRole('table', { name: 'Posições' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Posicoes />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

/**
 * SPEC-022 BR-022-18 / DL-022-17 — a width per column, from the definition and
 * never from the content.
 */
describe('Table — fixed layout', () => {
  function Fixa() {
    return (
      <Table fixed>
        <TableCaption>Fixa</TableCaption>
        <TableColGroup widths={['10ch', undefined, '6rem']} />
        <TableHeader>
          <TableRow>
            <TableHead scope="col">A</TableHead>
            <TableHead scope="col">B</TableHead>
            <TableHead scope="col">C</TableHead>
          </TableRow>
        </TableHeader>
      </Table>
    );
  }

  it('is automatic unless asked, so a table with no widths yet is not squeezed', () => {
    render(<Posicoes />);
    expect(screen.getByRole('table').className).not.toContain('table-fixed');
  });

  it('is fixed when asked, and still the full width of its container', () => {
    render(<Fixa />);
    const className = screen.getByRole('table').className;
    expect(className).toContain('table-fixed');
    expect(className).toContain('w-full');
  });

  it('takes each column width from its <col>, and leaves a column with none unset', () => {
    render(<Fixa />);
    const cols = Array.from(
      screen.getByRole('table').querySelectorAll<HTMLTableColElement>('colgroup > col'),
    );
    expect(cols.map((col) => col.style.width)).toEqual(['10ch', '', '6rem']);
  });

  it('still scrolls inside its own container rather than squeezing a column', () => {
    const { container } = render(<Fixa />);
    expect(container.querySelector('[data-slot="table-container"]')?.className).toContain(
      'overflow-x-auto',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Fixa />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
