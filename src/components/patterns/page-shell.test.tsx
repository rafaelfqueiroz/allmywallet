import { describe, expect, it } from 'vitest';
import { PageShell } from '@/components/patterns/page-shell';
import { Button } from '@/components/ui/button';
import { audit, render, screen } from '@/components/test-utils';

describe('PageShell', () => {
  it('renders its title as the page h1', () => {
    render(<PageShell title="Carteiras">conteúdo</PageShell>);
    expect(screen.getByRole('heading', { level: 1, name: 'Carteiras' })).toBeInTheDocument();
  });

  it('renders as a main landmark', () => {
    render(<PageShell title="Carteiras">conteúdo</PageShell>);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders without a header when no title, description or actions are given', () => {
    render(<PageShell>conteúdo</PageShell>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('places actions alongside the title', () => {
    render(
      <PageShell title="Carteiras" actions={<Button>Nova</Button>}>
        conteúdo
      </PageShell>,
    );
    expect(screen.getByRole('button', { name: 'Nova' })).toBeInTheDocument();
  });

  // The drift this component exists to end: five different max-widths across
  // five peer screens on main.
  it('offers three named widths and nothing else', () => {
    const widths = { narrow: 'max-w-2xl', default: 'max-w-5xl', wide: 'max-w-7xl' } as const;

    for (const [width, expected] of Object.entries(widths)) {
      const { unmount } = render(
        <PageShell width={width as keyof typeof widths}>conteúdo</PageShell>,
      );
      expect(screen.getByRole('main').className).toContain(expected);
      unmount();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <PageShell title="Carteiras" description="Agrupe seus ativos por objetivo.">
        conteúdo
      </PageShell>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
