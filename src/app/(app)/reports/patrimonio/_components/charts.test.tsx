import { describe, expect, it } from 'vitest';
import { audit, render, screen } from '@/components/test-utils';
import { ValueChart } from './ValueChart';
import { ContributionChart } from './ContributionChart';

/**
 * SPEC-013 charts, SPEC-016 BR-016-16.
 *
 * **These exist because the E2E sweep cannot reach them.** `/reports/patrimonio`
 * renders its signed-out state in the Playwright suite — there is no session to
 * drive yet — so axe there proves the empty state is accessible and nothing
 * about the charts. A chart that is inaccessible only once a user has data is
 * inaccessible for every user who matters.
 *
 * What is asserted is the text equivalent, not the pixels: a screen reader gets
 * the figures, not a description of a shape. Visual regression is explicitly
 * out of scope (TESTING §9).
 */

const POINTS = [
  { date: '2026-03-01', value: 100000, estimated: false },
  { date: '2026-03-31', value: 118500, estimated: true },
];

const BARS = [
  { month: '2026-01', amount: 1000 },
  // The month a bar chart must not hide: a net withdrawal.
  { month: '2026-02', amount: -500 },
];

describe('ValueChart', () => {
  it('exposes the plot as a named image', () => {
    render(
      <ValueChart
        title="Patrimônio ao longo do tempo"
        summary="De 100.000 a 118.500"
        points={POINTS}
      />,
    );
    expect(screen.getByRole('img', { name: 'Patrimônio ao longo do tempo' })).toBeInTheDocument();
  });

  it('describes the plot with the figures, not with a description of the shape', () => {
    render(
      <ValueChart
        title="Patrimônio ao longo do tempo"
        summary="De 100.000 a 118.500"
        points={POINTS}
      />,
    );
    const plot = screen.getByRole('img', { name: 'Patrimônio ao longo do tempo' });
    const describedBy = plot.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('De 100.000 a 118.500');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ValueChart
        title="Patrimônio ao longo do tempo"
        summary="De 100.000 a 118.500"
        points={POINTS}
      />,
    );
    expect((await audit(container)).violations).toEqual([]);
  });

  it('renders without a summary figure when there is nothing to plot', async () => {
    const { container } = render(<ValueChart title="Patrimônio" summary="Sem dados" points={[]} />);
    expect((await audit(container)).violations).toEqual([]);
  });
});

describe('ContributionChart', () => {
  it('exposes the plot as a named image', () => {
    render(<ContributionChart title="Aportes por mês" summary="Jan 1.000, Fev −500" bars={BARS} />);
    expect(screen.getByRole('img', { name: 'Aportes por mês' })).toBeInTheDocument();
  });

  /**
   * DL-05 / WCAG 1.4.1 — the negative month is distinguished by *position*
   * below the zero line as well as by colour, and its figure reaches a screen
   * reader through the summary rather than through the bar's fill.
   */
  it('carries the negative month into the text equivalent', () => {
    render(<ContributionChart title="Aportes por mês" summary="Jan 1.000, Fev −500" bars={BARS} />);
    const plot = screen.getByRole('img', { name: 'Aportes por mês' });
    const describedBy = plot.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('−500');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ContributionChart title="Aportes por mês" summary="Jan 1.000, Fev −500" bars={BARS} />,
    );
    expect((await audit(container)).violations).toEqual([]);
  });
});
