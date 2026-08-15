import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { audit, render, screen } from '@/components/test-utils';

describe('Badge', () => {
  it('renders every variant', () => {
    const variants = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const;

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

  it('has no axe violations', async () => {
    const { container } = render(<Badge>FII</Badge>);
    expect(await audit(container)).toHaveNoViolations();
  });
});
