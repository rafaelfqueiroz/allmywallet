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
          ariaLabel: 'Ver no Portfólio: patrimônio',
        }}
      >
        conteúdo
      </SummaryCard>,
    );
    const link = screen.getByRole('link', { name: 'Ver no Portfólio: patrimônio' });
    expect(link).toHaveAttribute('href', '/portfolio');
    expect(link).toHaveTextContent('Ver no Portfólio');
    // The indent the owner saw came from `Button`'s padding; neither the link
    // nor its row has any. The rendered edge is measured in the E2E.
    const row = container.querySelector('[data-slot="card-link"]');
    expect(row).not.toBeNull();
    for (const className of [link.className, row?.className ?? '']) {
      expect(className).not.toMatch(/\b(p|px|pl|ps|m|mx|ml|ms)-/);
    }
  });

  // WCAG 2.5.3 — a name that does not begin with the visible text is dropped.
  it('keeps the visible label as the name when an aria-label would hide it', () => {
    render(
      <SummaryCard title="T" link={{ href: '/x', label: 'Ver', ariaLabel: 'Outra coisa' }}>
        x
      </SummaryCard>,
    );
    expect(screen.getByRole('link', { name: 'Ver' })).not.toHaveAttribute('aria-label');
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
