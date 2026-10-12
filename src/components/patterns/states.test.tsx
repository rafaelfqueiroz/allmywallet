import { describe, expect, it } from 'vitest';
import { Inbox } from 'lucide-react';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard, StatCardSkeleton } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Money as MoneyValue } from '@/core/shared/money';
import { Button } from '@/components/ui/button';
import { audit, render, screen } from '@/components/test-utils';

describe('EmptyState', () => {
  it('explains the absence instead of leaving a blank region', () => {
    render(<EmptyState title="Nada por aqui ainda" description="Importe um extrato da B3." />);
    expect(screen.getByText('Nada por aqui ainda')).toBeInTheDocument();
    expect(screen.getByText('Importe um extrato da B3.')).toBeInTheDocument();
  });

  // SPEC-011: an empty report must never be indistinguishable from a zero one.
  it('is announced as a status, so a filter that empties the view is not silence', () => {
    render(<EmptyState title="Nada por aqui ainda" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('hides a decorative icon from assistive technology', () => {
    const { container } = render(<EmptyState title="Nada" icon={<Inbox />} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <EmptyState
        title="Nada"
        description="Importe um extrato."
        action={<Button>Importar</Button>}
      />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('ErrorState', () => {
  // A failure and an absence must not render the same: only one is worth retrying.
  it('is announced as an alert, not a status', () => {
    render(<ErrorState title="Não foi possível carregar" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('carries a retry control when retrying is meaningful', () => {
    render(<ErrorState title="Falhou" action={<Button>Tentar novamente</Button>} />);
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorState title="Falhou" description="Tente de novo em instantes." />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('StatCard', () => {
  it('pairs the label with the value as a description list', () => {
    const { container } = render(
      <StatCard label="Patrimônio" value={<Money value={MoneyValue.fromString('1234.56')} />} />,
    );

    expect(container.querySelector('dt')?.textContent).toBe('Patrimônio');
    expect(container.querySelector('dd')?.textContent).toContain('1.234,56');
  });

  it('renders a hint when given one', () => {
    render(<StatCard label="Patrimônio" value="R$ 0,00" hint="Atualizado há 30 minutos" />);
    expect(screen.getByText('Atualizado há 30 minutos')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<StatCard label="Patrimônio" value="R$ 1,00" />);
    expect(await audit(container)).toHaveNoViolations();
  });

  // SPEC-022 BR-022-36 — a figure inside a panel draws no second border.
  it('drops its own border when inset in a panel', () => {
    const { container, rerender } = render(<StatCard label="Meta" value="R$ 1,00" />);
    const card = () => container.querySelector('[data-slot=stat-card]')!;
    expect(card()).not.toHaveAttribute('data-inset');
    expect(card()).toHaveClass('ring-1');
    rerender(<StatCard inset label="Meta" value="R$ 1,00" />);
    expect(card()).toHaveAttribute('data-inset', 'true');
    expect(card()).toHaveClass('ring-0', 'bg-muted/50');
    expect(card()).not.toHaveClass('ring-1');
  });

  // SPEC-022 BR-022-07 — the figure links to the destination that owns it.
  it('links to the destination that owns the figure, outside the description list', async () => {
    const { container } = render(
      <StatCard
        label="Patrimônio"
        value="R$ 1,00"
        link={{ href: '/portfolio', label: 'Ver no Portfólio' }}
      />,
    );
    const link = screen.getByRole('link', { name: 'Ver no Portfólio' });
    expect(link).toHaveAttribute('href', '/portfolio');
    // A `dl` may hold only `dt`/`dd` groups; the link is the card's, not the pair's.
    expect(link.closest('dl')).toBeNull();
    expect(await audit(container)).toHaveNoViolations();
  });

  it('has no axe violations while loading', async () => {
    const { container } = render(<StatCardSkeleton />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
