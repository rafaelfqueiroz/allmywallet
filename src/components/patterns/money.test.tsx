import { describe, expect, it } from 'vitest';
import { Money as MoneyValue, Quantity } from '@/core/shared/money';
import { Money } from '@/components/patterns/money';
import { audit, render, screen } from '@/components/test-utils';

describe('Money', () => {
  it('formats currency through the i18n formatter', () => {
    render(<Money value={MoneyValue.fromString('1234.56')} />);
    expect(screen.getByText(/1\.234,56/)).toBeInTheDocument();
  });

  it('renders tabular numerals so a column aligns on the decimal point', () => {
    const { container } = render(<Money value={MoneyValue.fromString('10')} />);
    expect(container.querySelector('[data-slot="money"]')?.className).toContain('tabular-nums');
  });

  it('shows no sign and no colour when unsigned, even for a negative value', () => {
    const { container } = render(<Money value={MoneyValue.fromString('-10')} />);
    const el = container.querySelector('[data-slot="money"]');

    expect(el?.className).not.toContain('text-negative');
    expect(el).not.toHaveAttribute('data-sign');
  });

  // DS-09: the sign is not decoration. It is what keeps the meaning available
  // to a red-green colour blind user, so it must be impossible to get the
  // colour without it.
  it('pairs the negative colour with an explicit minus sign', () => {
    const { container } = render(<Money value={MoneyValue.fromString('-1234.56')} signed />);
    const el = container.querySelector('[data-slot="money"]');

    expect(el?.className).toContain('text-negative');
    expect(el?.textContent?.startsWith('−')).toBe(true);
  });

  it('pairs the positive colour with an explicit plus sign', () => {
    const { container } = render(<Money value={MoneyValue.fromString('1234.56')} signed />);
    const el = container.querySelector('[data-slot="money"]');

    expect(el?.className).toContain('text-positive');
    expect(el?.textContent?.startsWith('+')).toBe(true);
  });

  it('renders the magnitude once — the sign never doubles up', () => {
    const { container } = render(<Money value={MoneyValue.fromString('-10')} signed />);
    expect(container.textContent).not.toContain('−-');
  });

  it('treats zero as neither positive nor negative', () => {
    const { container } = render(<Money value={MoneyValue.fromString('0')} signed />);
    const el = container.querySelector('[data-slot="money"]');

    expect(el).toHaveAttribute('data-sign', 'zero');
    expect(el?.className).not.toContain('text-positive');
    expect(el?.className).not.toContain('text-negative');
  });

  it('formats a quantity without a currency symbol', () => {
    const { container } = render(<Money value={Quantity.fromString('100')} kind="quantity" />);
    expect(container.textContent).not.toContain('R$');
    expect(container.textContent).toContain('100');
  });

  it('signs a quantity, which has no abs() of its own', () => {
    const { container } = render(
      <Money value={Quantity.fromString('-5')} kind="quantity" signed />,
    );
    expect(container.textContent).toBe('−5');
  });

  it('formats a percent from a fraction', () => {
    const { container } = render(<Money value={MoneyValue.fromString('0.1234')} kind="percent" />);
    expect(container.textContent).toContain('12,34%');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Money value={MoneyValue.fromString('1')} signed />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
