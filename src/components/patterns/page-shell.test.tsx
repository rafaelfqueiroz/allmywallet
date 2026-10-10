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

  // BR-022-14: one header implementation, reached through the shell.
  it('renders its header through PageHeader, scope slot included', () => {
    render(
      <PageShell title="Relatórios" scope={<button type="button">Escopo</button>}>
        conteúdo
      </PageShell>,
    );
    expect(screen.getByRole('button', { name: 'Escopo' })).toBeInTheDocument();
    expect(screen.getByRole('main').querySelector('[data-slot="page-header"]')).not.toBeNull();
  });

  // SPEC-022 BR-022-14: one width, and no prop or class to choose another.
  it('renders one maximum width and one left edge for every page', () => {
    const { unmount } = render(<PageShell title="Painel">conteúdo</PageShell>);
    const first = screen.getByRole('main').className;
    unmount();

    render(<PageShell title="Relatórios">conteúdo</PageShell>);
    expect(screen.getByRole('main').className).toBe(first);
    expect(first).toContain('max-w-7xl');
    expect(first).toContain('mx-auto');
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
