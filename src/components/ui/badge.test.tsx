import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { audit, render, screen } from '@/components/test-utils';

describe('Badge', () => {
  it('renders every variant', () => {
    const variants = [
      'default',
      'secondary',
      'destructive',
      'outline',
      'ghost',
      'link',
      'success',
      'progress',
      'warning',
      'danger',
      'neutral',
    ] as const;

    for (const variant of variants) {
      const { unmount } = render(<Badge variant={variant}>FII</Badge>);
      expect(screen.getByText('FII')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders as its child element when asChild', () => {
    render(
      <Badge asChild>
        <a href="/carteiras">FII</a>
      </Badge>,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/carteiras');
  });

  // SPEC-022 BR-022-31 — one variant per status, each its own colour pair, none
  // borrowing the loss colour or the destructive-action colour (DS-47).
  describe('status variants', () => {
    const statuses = ['success', 'progress', 'warning', 'danger', 'neutral'] as const;

    it.each(statuses)('%s uses its own text colour on its own surface', (status) => {
      render(<Badge variant={status}>Concluída</Badge>);
      const badge = screen.getByText('Concluída');
      expect(badge).toHaveAttribute('data-variant', status);
      expect(badge.className).toContain(`bg-${status}-surface`);
      expect(badge.className).toContain(`text-${status}`);
    });

    it('never gives a status the destructive or negative colour', () => {
      for (const status of ['success', 'progress', 'warning', 'neutral'] as const) {
        const { unmount } = render(<Badge variant={status}>x</Badge>);
        const className = screen.getByText('x').className;
        expect(className).not.toMatch(/destructive|negative/);
        unmount();
      }
    });

    it('has no axe violations for any status, with or without the dot', async () => {
      for (const status of statuses) {
        for (const dot of [false, true]) {
          const { container, unmount } = render(
            <Badge variant={status} dot={dot}>
              Concluída
            </Badge>,
          );
          expect(await audit(container)).toHaveNoViolations();
          unmount();
        }
      }
    });
  });

  describe('dot', () => {
    it('is decoration: hidden from assistive technology and absent by default', () => {
      const { container, rerender } = render(<Badge variant="success">Concluída</Badge>);
      expect(container.querySelector('[data-slot="badge-dot"]')).toBeNull();

      rerender(
        <Badge variant="success" dot>
          Concluída
        </Badge>,
      );
      const dot = container.querySelector('[data-slot="badge-dot"]');
      expect(dot).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByText('Concluída')).toHaveTextContent('Concluída');
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(<Badge>FII</Badge>);
    expect(await audit(container)).toHaveNoViolations();
  });
});
