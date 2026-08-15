import { describe, expect, it } from 'vitest';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
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
