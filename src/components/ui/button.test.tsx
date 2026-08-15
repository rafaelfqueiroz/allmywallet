import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import { audit, render, screen } from '@/components/test-utils';

describe('Button', () => {
  it('renders every variant', () => {
    const variants = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;

    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>x</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('data-variant', variant);
      unmount();
    }
  });

  it('renders every size', () => {
    const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;

    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>x</Button>);
      expect(screen.getByRole('button')).toHaveAttribute('data-size', size);
      unmount();
    }
  });

  it('carries a focus-visible ring', () => {
    render(<Button>x</Button>);
    expect(screen.getByRole('button').className).toContain('focus-visible:ring-ring');
  });

  it('is disabled through the native attribute, not styling alone', () => {
    render(<Button disabled>x</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders as its child element when asChild, keeping link semantics', () => {
    render(
      <Button asChild>
        <a href="/carteiras">x</a>
      </Button>,
    );
    // A link styled as a button must still be a link: it navigates, it opens in
    // a new tab, and a screen reader announces it as a link.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/carteiras');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Button>x</Button>);
    expect(await audit(container)).toHaveNoViolations();
  });
});
