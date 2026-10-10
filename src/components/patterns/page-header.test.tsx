import { describe, expect, it } from 'vitest';
import { PageHeader } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { audit, render, screen } from '@/components/test-utils';

describe('PageHeader', () => {
  it('renders its title as the page h1', () => {
    render(<PageHeader title="Portfólio" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Portfólio' })).toBeInTheDocument();
  });

  it('renders the description under the title', () => {
    render(<PageHeader title="Portfólio" description="Seu patrimônio em um lugar." />);
    expect(screen.getByText('Seu patrimônio em um lugar.')).toBeInTheDocument();
  });

  it('places the primary actions in the header', () => {
    render(<PageHeader title="Carteiras" actions={<Button>Nova carteira</Button>} />);
    expect(screen.getByRole('button', { name: 'Nova carteira' })).toBeInTheDocument();
  });

  it('places the scope slot in the header, before the actions', () => {
    render(
      <PageHeader
        title="Relatórios"
        scope={<button type="button">Escopo</button>}
        actions={<Button>Exportar</Button>}
      />,
    );
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Escopo', 'Exportar']);
  });

  // Inside <main> a `header` carries no banner role, which testing-library's
  // role model does not know; axe does, so it is asserted there.
  it('adds no second banner landmark inside main', async () => {
    const { container } = render(
      <main>
        <PageHeader title="Portfólio" />
      </main>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations with every slot filled', async () => {
    const { container } = render(
      <PageHeader
        title="Relatórios"
        description="Patrimônio e rentabilidade."
        scope={<button type="button">Escopo</button>}
        actions={<Button>Exportar</Button>}
      />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
