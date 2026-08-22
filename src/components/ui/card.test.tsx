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

  // #37: a card that *is* a section of the document needs a real heading, or
  // the page has one h1 and nothing else to navigate by. Default stays a div —
  // a card inside content is a label, not an outline entry.
  it('renders its title as a plain div by default and as the given element with asChild', () => {
    const { rerender } = render(<CardTitle>Composição</CardTitle>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    rerender(
      <CardTitle asChild>
        <h3>Composição</h3>
      </CardTitle>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Composição' })).toBeInTheDocument();
  });
});
