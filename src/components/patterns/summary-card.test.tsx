import { describe, expect, it } from 'vitest';
import { CardItemLink, SummaryCard } from '@/components/patterns/summary-card';
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
    expect(container.querySelector('[data-slot="section-footer"]')).toBeNull();
  });

  // SPEC-022 BR-022-36 (#243) — a panel: the link is its footer, under a
  // hairline that runs edge to edge, not a row inside the body's padding.
  it('is a panel whose footer holds the link', () => {
    const { container } = render(
      <SummaryCard title="T" link={{ href: '/x', label: 'Ver' }}>
        x
      </SummaryCard>,
    );
    const panel = container.querySelector('[data-slot="summary-card"]');
    expect(panel).toHaveAttribute('data-variant', 'panel');
    const footer = container.querySelector('[data-slot="section-footer"]');
    expect(footer?.parentElement).toBe(panel);
    expect(footer).toContainElement(screen.getByRole('link', { name: 'Ver' }));
  });

  it('shows a focus ring on its link (DS-06)', () => {
    render(
      <SummaryCard title="T" link={{ href: '/x', label: 'Ver' }}>
        x
      </SummaryCard>,
    );
    expect(screen.getByRole('link', { name: 'Ver' }).className).toContain('focus-visible:ring');
  });

  // #243 — the watch card's asset code: its own line, so a table cell can
  // truncate it and keep its box inside the cell.
  it('links an item by its own name, as a line a cell can truncate', () => {
    render(
      <CardItemLink href="/settings/watch#regra-1" label="ITSA4" ariaLabel="ITSA4: ver regra" />,
    );
    const link = screen.getByRole('link', { name: 'ITSA4: ver regra' });
    expect(link).toHaveAttribute('href', '/settings/watch#regra-1');
    expect(link).toHaveTextContent('ITSA4');
    expect(link).toHaveAttribute('data-cell-line');
    expect(link.className).toContain('max-w-full');
    // The cell clips at the link's edges, so its focus ring is drawn inside.
    expect(link.className).toContain('focus-visible:ring-inset');
  });

  it("drops an item link's aria-label that does not begin with its text (WCAG 2.5.3)", () => {
    render(<CardItemLink href="/x" label="ITSA4" ariaLabel="Ver regra de ITSA4" />);
    expect(screen.getByRole('link', { name: 'ITSA4' })).not.toHaveAttribute('aria-label');
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
