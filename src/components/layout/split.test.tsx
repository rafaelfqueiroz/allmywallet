import { describe, expect, it } from 'vitest';
import { Split } from '@/components/layout/split';
import { audit, render } from '@/components/test-utils';

describe('Split', () => {
  it('is one column by default — the mobile case is not an override', () => {
    const { container } = render(
      <Split>
        <div>a</div>
        <div>b</div>
      </Split>,
    );
    const split = container.querySelector('[data-slot="split"]');
    expect(split?.className).toContain('grid-cols-1');
  });

  it('splits on its container, not the viewport, and keeps the fluid column shrinkable', () => {
    const end = render(<Split side="end">x</Split>);
    expect(end.container.querySelector('[data-slot="split-container"]')?.className).toContain(
      '@container',
    );
    expect(end.container.querySelector('[data-slot="split"]')?.className).toContain(
      'minmax(0,1fr)_20rem',
    );
    end.unmount();

    const even = render(<Split side="even">x</Split>);
    expect(even.container.querySelector('[data-slot="split"]')?.className).toContain(
      '@2xl:grid-cols-2',
    );
    even.unmount();

    const aside = render(<Split side="aside">x</Split>);
    expect(aside.container.querySelector('[data-slot="split"]')?.className).toContain(
      // #243 — 3:2, the narrow column never under the frame's ~430px.
      '@3xl:grid-cols-[minmax(0,3fr)_minmax(27rem,2fr)]',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Split>x</Split>);
    expect(await audit(container)).toHaveNoViolations();
  });
});
