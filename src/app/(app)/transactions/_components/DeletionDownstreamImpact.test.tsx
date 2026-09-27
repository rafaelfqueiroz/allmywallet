import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@/core/shared/money';
import { makePosition } from '@/core/positions/position-state';
import { render, screen, within } from '@/components/test-utils';
import { DeletionDownstreamImpact, type DownstreamImpactRow } from './DeletionDownstreamImpact';

/**
 * SPEC-006 BR-006-13 (#144 re-review N3) — the delete confirmation states the
 * other positions a delete recalculates, or nothing when there are none.
 *
 * The figures are the hand-computed #144 case: B received 100 at a carried
 * 27,48333333 (2.748,333333, estimated); without the estimated subscription at
 * A it carries 10,00 (1.000,00, exact).
 */
const position = (quantity: string, totalCost: string) =>
  makePosition(Quantity.fromString(quantity), Money.fromString(totalCost), Money.zero());

const row: DownstreamImpactRow = {
  key: 'petr4|b',
  assetLabel: 'PETR4',
  institutionLabel: 'Corretora B',
  currentPosition: position('100', '2748.333333'),
  projectedPosition: position('100', '1000'),
  currentCostEstimated: true,
  projectedCostEstimated: false,
};

describe('DeletionDownstreamImpact', () => {
  it('absent: renders nothing when the delete reaches no other position', () => {
    const { container } = render(<DeletionDownstreamImpact rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('present: names each position with today’s and the projected figures and markers', () => {
    render(<DeletionDownstreamImpact rows={[row]} />);

    expect(
      screen.getByRole('heading', { name: 'Outras posições recalculadas' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'PETR4 em Corretora B' });
    const [, quantity, average, total] = within(table).getAllByRole('row');
    expect(within(quantity as HTMLElement).getAllByText('100')).toHaveLength(2);
    // 2.748,333333 ÷ 100 = 27,48333333 → R$ 27,48 today, R$ 10,00 after.
    expect(within(average as HTMLElement).getByText(/27,48/)).toBeInTheDocument();
    expect(within(average as HTMLElement).getByText(/10,00/)).toBeInTheDocument();
    // SPEC-007 BR-007-06: marked today, exact after — one marker, not two.
    expect(within(average as HTMLElement).getAllByText('Preço estimado')).toHaveLength(1);
    expect(within(total as HTMLElement).getByText(/2\.748,33/)).toBeInTheDocument();
    expect(within(total as HTMLElement).getByText(/1\.000,00/)).toBeInTheDocument();
  });

  it('present, no institution: says so rather than leaving a gap', () => {
    render(<DeletionDownstreamImpact rows={[{ ...row, institutionLabel: null }]} />);
    expect(screen.getByRole('table', { name: 'PETR4, sem instituição' })).toBeInTheDocument();
  });
});
