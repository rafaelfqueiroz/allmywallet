import { describe, expect, it } from 'vitest';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { audit, render, screen } from '@/components/test-utils';

function Patrimonio() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patrimônio</CardTitle>
        <CardDescription>Posição consolidada</CardDescription>
        <CardAction>
          <Button size="xs">Atualizar</Button>
        </CardAction>
      </CardHeader>
      <CardContent>R$ 1.234,56</CardContent>
      <CardFooter>Atualizado hoje</CardFooter>
    </Card>
  );
}

describe('Card', () => {
  it('renders each of its slots', () => {
    render(<Patrimonio />);
    expect(screen.getByText('Patrimônio')).toBeInTheDocument();
    expect(screen.getByText('Posição consolidada')).toBeInTheDocument();
    expect(screen.getByText('R$ 1.234,56')).toBeInTheDocument();
    expect(screen.getByText('Atualizado hoje')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Atualizar' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Patrimonio />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
