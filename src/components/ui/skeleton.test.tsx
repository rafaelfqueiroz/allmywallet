import { describe, expect, it } from 'vitest';
import { Skeleton } from '@/components/ui/skeleton';
import { audit, render } from '@/components/test-utils';

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.querySelector('[data-slot="skeleton"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
