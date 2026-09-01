import { describe, expect, it } from 'vitest';
import { StateBadge, type WatchState } from '@/components/patterns/state-badge';
import { audit, render, screen } from '@/components/test-utils';

/**
 * SPEC-018 — "every state is rendered with both a colour and a text label;
 * an automated check fails the build if a state renders as colour alone."
 *
 * `label` is a required prop on `StateBadge` (TypeScript enforces that at
 * compile time), but the acceptance criterion is about the *rendered output*,
 * not the type signature — so every case below actually queries for the
 * visible text rather than trusting that the prop was supplied. If a future
 * edit made `label` optional and a call site started omitting it, these
 * assertions would fail exactly where the type-level guarantee no longer
 * could.
 */
describe('StateBadge', () => {
  const cases: readonly { readonly state: WatchState; readonly label: string }[] = [
    { state: 'buy', label: 'compra' },
    { state: 'hold', label: 'manutenção' },
    { state: 'sell', label: 'venda' },
    { state: 'unknown', label: 'sem cotação válida' },
  ];

  it.each(cases)(
    'renders visible text for the $state state, never colour alone',
    ({ state, label }) => {
      const { unmount } = render(<StateBadge state={state} label={label} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    },
  );

  it('marks the state as data for tests/tooling without relying on colour', () => {
    render(<StateBadge state="sell" label="venda" />);
    expect(screen.getByText('venda').closest('[data-state]')).toHaveAttribute('data-state', 'sell');
  });

  /**
   * DL-018-06 — buy, hold and sell each get their own class, and none of
   * them is the `negative` (red) tone a gain/loss figure would use. `unknown`
   * gets the neutral treatment, not a fifth colour of its own.
   */
  it('gives buy, hold, sell and unknown four distinct, non-destructive treatments', () => {
    const classesByState = cases.map(({ state, label }) => {
      const { container, unmount } = render(<StateBadge state={state} label={label} />);
      const className = container.querySelector('[data-slot="state-badge"]')?.className ?? '';
      unmount();
      return className;
    });

    expect(new Set(classesByState).size).toBe(4);
    for (const className of classesByState) {
      expect(className).not.toContain('text-destructive');
      expect(className).not.toContain('text-negative');
    }
  });

  it('has no axe violations for every state', async () => {
    for (const { state, label } of cases) {
      const { container, unmount } = render(<StateBadge state={state} label={label} />);
      expect(await audit(container)).toHaveNoViolations();
      unmount();
    }
  });
});
