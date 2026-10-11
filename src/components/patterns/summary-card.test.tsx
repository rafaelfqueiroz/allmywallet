import { describe, expect, it } from 'vitest';
import { SummaryCard } from '@/components/patterns/summary-card';
import { Badge } from '@/components/ui/badge';
import { audit, render, screen } from '@/components/test-utils';

describe('SummaryCard', () => {
  it('is a section headed by an h2, with its badge beside the heading', () => {
    render(
      <SummaryCard
        title="Conferência com a B3"
        badge={
          <Badge variant="warning" dot>
            1 divergência em aberto
          </Badge>
        }
      >
        conteúdo
      </SummaryCard>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Conferência com a B3' });
    expect(heading.closest('section')).toHaveAttribute('data-slot', 'summary-card');
    expect(heading.closest('header')).toHaveTextContent('1 divergência em aberto');
  });

  // SPEC-022 BR-022-07 — each card links to the destination that owns its detail.
  it('links to the owning destination, with no inset of its own (#213)', () => {
    const { container } = render(
      <SummaryCard
        title="Patrimônio"
        link={{
          href: '/portfolio',
          label: 'Ver no Portfólio',
          ariaLabel: 'Patrimônio no Portfólio',
        }}
      >
        conteúdo
      </SummaryCard>,
    );
    const link = screen.getByRole('link', { name: 'Patrimônio no Portfólio' });
    expect(link).toHaveAttribute('href', '/portfolio');
    expect(link).toHaveTextContent('Ver no Portfólio');
    // The indent the owner saw came from `Button`'s padding; a card link has none.
    expect(link.className).not.toMatch(/\bpx-/);
    expect(container.querySelector('[data-slot="card-link"]')).not.toBeNull();
  });

  it('renders no footer row without a link', () => {
    const { container } = render(<SummaryCard title="Precisa da sua atenção">x</SummaryCard>);
    expect(container.querySelector('[data-slot="card-link"]')).toBeNull();
  });

  it('shows a focus ring on its link (DS-06)', () => {
    render(
      <SummaryCard title="T" link={{ href: '/x', label: 'Ver' }}>
        x
      </SummaryCard>,
    );
    expect(screen.getByRole('link', { name: 'Ver' }).className).toContain('focus-visible:ring');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <SummaryCard
        title="Em zona de compra ou venda"
        action={<a href="/settings/watch">Regras</a>}
        link={{ href: '/portfolio', label: 'Ver no Portfólio' }}
      >
        conteúdo
      </SummaryCard>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
