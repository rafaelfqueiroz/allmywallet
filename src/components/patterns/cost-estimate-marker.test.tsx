import { describe, expect, it } from 'vitest';
import { CostEstimateMarker } from '@/components/patterns/cost-estimate-marker';
import { audit, render, screen } from '@/components/test-utils';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / DL-007-12 — "an estimated cost is
 * carried and shown, never hidden," everywhere a position's cost or *preço
 * médio* is shown.
 */
describe('CostEstimateMarker', () => {
  it('shown: renders the visible label and an accessible explanation', () => {
    render(
      <CostEstimateMarker shown label="Preço estimado" title="O custo desta posição é estimado." />,
    );
    const badge = screen.getByText('Preço estimado');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'O custo desta posição é estimado.');
  });

  it('hidden: renders nothing for a position with no estimated cost', () => {
    const { container } = render(
      <CostEstimateMarker shown={false} label="Preço estimado" title="irrelevant" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations when shown', async () => {
    const { container } = render(
      <CostEstimateMarker shown label="Preço estimado" title="O custo desta posição é estimado." />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});
