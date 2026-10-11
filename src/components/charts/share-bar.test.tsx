import { describe, expect, it } from 'vitest';
import { ShareBar } from '@/components/charts/share-bar';
import { assetClassColor } from '@/components/charts/palette';
import { audit, render } from '@/components/test-utils';

describe('ShareBar', () => {
  it('draws the share as the fill width, in the series colour', () => {
    const { container } = render(<ShareBar percent="48.4" color={assetClassColor('stock')} />);
    const fill = container.querySelector<HTMLElement>('[data-slot="share-bar"] > div');
    expect(fill?.style.width).toBe('48.4%');
    expect(fill?.style.backgroundColor).toBe(assetClassColor('stock'));
  });

  // Decoration for the percentage printed beside it: one figure, announced once.
  it('is hidden from assistive technology and takes no focus', () => {
    const { container } = render(<ShareBar percent="10" color={assetClassColor('fii')} />);
    const bar = container.querySelector('[data-slot="share-bar"]');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar?.querySelector('[tabindex]')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <p>
        Ações 48,4% <ShareBar percent="48.4" color={assetClassColor('stock')} />
      </p>,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
