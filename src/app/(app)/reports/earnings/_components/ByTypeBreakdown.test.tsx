import { describe, expect, it } from 'vitest';
import { Money } from '@/core/shared/money';
import { audit, render, screen } from '@/components/test-utils';
import { ByTypeBreakdown, type ByTypeItem } from './ByTypeBreakdown';

/**
 * SPEC-014 BR-014-01 / #113 (DL-014-08) — five provento buckets, not four.
 *
 * `report.byType` (`core/reporting/earnings/received.ts`'s `totalsByType`) is
 * already driven from `EARNING_TYPES`, so the fifth entry — `leilao_fracoes`
 * — exists in the data the moment the core does. What this test proves is the
 * half that lives on this side of the boundary: the component renders
 * whatever list it is given, at any length, rather than assuming four.
 */
const items: readonly ByTypeItem[] = [
  { type: 'dividend', label: 'Dividendos', amount: Money.fromString('100') },
  { type: 'jcp', label: 'JCP', amount: Money.fromString('50') },
  { type: 'rendimento', label: 'Rendimentos', amount: Money.fromString('200') },
  { type: 'amortization', label: 'Amortizações', amount: Money.fromString('0') },
  { type: 'leilao_fracoes', label: 'Leilão de frações', amount: Money.fromString('12.34') },
];

describe('ByTypeBreakdown', () => {
  it('renders all five buckets, including leilão de frações', () => {
    render(<ByTypeBreakdown items={items} />);

    expect(screen.getByText('Dividendos')).toBeInTheDocument();
    expect(screen.getByText('JCP')).toBeInTheDocument();
    expect(screen.getByText('Rendimentos')).toBeInTheDocument();
    expect(screen.getByText('Amortizações')).toBeInTheDocument();
    expect(screen.getByText('Leilão de frações')).toBeInTheDocument();
  });

  it('renders a zero-paying type rather than omitting it', () => {
    render(<ByTypeBreakdown items={items} />);
    // BR-014-01: every type is present even at zero — Amortizações above.
    const amortizacoes = screen.getByText('Amortizações').closest('[data-slot="stat-card"]');
    expect(amortizacoes?.textContent).toMatch(/R\$\s*0,00/);
  });

  it('formats the leilão de frações figure through the shared money formatter', () => {
    render(<ByTypeBreakdown items={items} />);
    const card = screen.getByText('Leilão de frações').closest('[data-slot="stat-card"]');
    expect(card?.textContent).toMatch(/R\$\s*12,34/);
  });

  it('is not the sole carrier of the figures — every value is plain text', () => {
    // SPEC-016 BR-016-16: nothing here is canvas/SVG; each amount is a `dd`
    // paired with its `dt` label, reachable by a screen reader and by a text
    // search, which is what the three assertions above already exercise.
    const { container } = render(<ByTypeBreakdown items={items} />);
    expect(container.querySelectorAll('dt')).toHaveLength(5);
    expect(container.querySelectorAll('dd')).toHaveLength(5);
  });

  it('has no axe violations', async () => {
    const { container } = render(<ByTypeBreakdown items={items} />);
    expect(await audit(container)).toHaveNoViolations();
  });

  it('renders an empty grid rather than crashing when given no items', () => {
    const { container } = render(<ByTypeBreakdown items={[]} />);
    expect(container.querySelectorAll('[data-slot="stat-card"]')).toHaveLength(0);
  });
});
