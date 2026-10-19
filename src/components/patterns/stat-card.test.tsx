import { describe, expect, it } from 'vitest';
import { StatCard } from '@/components/patterns/stat-card';
import { audit, render, screen, userEvent } from '@/components/test-utils';

const TEXT = 'Quanto custaram os ativos que você tem hoje.';

describe('StatCard', () => {
  it('pairs its label with its value', () => {
    render(<StatCard label="Valor aplicado" value="R$ 10,00" />);
    expect(screen.getByRole('term')).toHaveTextContent('Valor aplicado');
    expect(screen.getByRole('definition')).toHaveTextContent('R$ 10,00');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // SPEC-022 BR-022-39 — each invested figure says what it measures.
  it('explains its figure behind an info icon beside the label', async () => {
    const user = userEvent.setup();
    render(
      <StatCard label="Valor aplicado" value="R$ 10,00" info={{ id: 'applied', text: TEXT }} />,
    );
    const icon = screen.getByRole('button', { name: 'Instruções sobre Valor aplicado' });
    expect(icon).toHaveAccessibleDescription(TEXT);
    await user.tab();
    expect(icon).toHaveFocus();
    expect(screen.getByRole('note')).toHaveTextContent(TEXT);
  });

  // SPEC-022 BR-022-07/36 (#243) — the link is the card's footer, a direct
  // child of the card, so its hairline runs edge to edge.
  it('links to its destination from a footer row', () => {
    const { container } = render(
      <StatCard label="Patrimônio" value="R$ 1,00" link={{ href: '/portfolio', label: 'Ver' }} />,
    );
    const footer = container.querySelector('[data-slot="card-footer"]');
    expect(footer?.parentElement).toHaveAttribute('data-slot', 'stat-card');
    expect(footer).toContainElement(screen.getByRole('link', { name: 'Ver' }));
  });

  it('has no axe violations with an info icon', async () => {
    const { baseElement } = render(
      <StatCard label="Valor aplicado" value="R$ 10,00" info={{ id: 'applied', text: TEXT }} />,
    );
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
