import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { render, screen } from '@/components/test-utils';
import { TransactionCostEstimateMarker } from './TransactionCostEstimateMarker';

/**
 * SPEC-007 BR-007-06 (amended 2026-09-21) / SPEC-005 BR-005-20d / DL-007-11 —
 * the three states a single transaction's cost-estimate marker can be in.
 */
describe('TransactionCostEstimateMarker', () => {
  const closeExplanation = (date: BusinessDate) => `Preço estimado pelo fechamento de ${date}`;
  const carriedExplanation = 'Custo herdado de uma posição com preço estimado';

  it('hidden: an ordinary transaction shows no marker', () => {
    const { container } = render(
      <TransactionCostEstimateMarker
        costIsEstimate={false}
        estimateCloseDate={null}
        label="Estimado"
        closeExplanation={closeExplanation}
        carriedExplanation={carriedExplanation}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shown, with a close date: a subscription priced at a stored close', () => {
    render(
      <TransactionCostEstimateMarker
        costIsEstimate
        estimateCloseDate={BusinessDate.of('2024-02-22')}
        label="Estimado"
        closeExplanation={closeExplanation}
        carriedExplanation={carriedExplanation}
      />,
    );
    const badge = screen.getByText('Estimado');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Preço estimado pelo fechamento de 2024-02-22');
  });

  it('shown, carried wording: a transfer or conversion leg from an estimated source lot', () => {
    render(
      <TransactionCostEstimateMarker
        costIsEstimate
        estimateCloseDate={null}
        label="Estimado"
        closeExplanation={closeExplanation}
        carriedExplanation={carriedExplanation}
      />,
    );
    const badge = screen.getByText('Estimado');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', carriedExplanation);
  });
});
