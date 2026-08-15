import { describe, expect, it } from 'vitest';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { audit, render } from '@/components/test-utils';

describe('Stack', () => {
  it('maps each named gap to a class', () => {
    for (const gap of ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const) {
      const { container, unmount } = render(<Stack gap={gap}>x</Stack>);
      expect(container.querySelector('[data-slot="stack"]')?.className).toContain('flex-col');
      unmount();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<Stack>x</Stack>);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('Cluster', () => {
  it('wraps by default, because a row of controls on a phone must not overflow', () => {
    const { container } = render(<Cluster>x</Cluster>);
    expect(container.querySelector('[data-slot="cluster"]')?.className).toContain('flex-wrap');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Cluster>x</Cluster>);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('Grid', () => {
  // DL-12: the mobile case is the default, not an override. A caller cannot
  // produce a four-column grid on a 375px screen by forgetting a breakpoint.
  it('starts every variant at one column and widens at a breakpoint', () => {
    for (const cols of [1, 2, 3, 4] as const) {
      const { container, unmount } = render(<Grid cols={cols}>x</Grid>);
      const className = container.querySelector('[data-slot="grid"]')?.className ?? '';

      expect(className).toContain('grid-cols-1');
      if (cols > 1) expect(className).toContain('sm:grid-cols-2');
      unmount();
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<Grid>x</Grid>);
    expect(await audit(container)).toHaveNoViolations();
  });
});
