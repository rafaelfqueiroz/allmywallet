import { describe, expect, it } from 'vitest';
import { EstimateMarker } from '@/components/patterns/estimate-marker';
import { audit, render, screen, userEvent } from '@/components/test-utils';

/**
 * SPEC-022 BR-022-32 (amended 2026-10-12, DL-022-19) — two estimates, two
 * labels, each with an info icon whose explanation opens on hover, focus and
 * tap and is the icon's accessible description. SPEC-009 BR-009-11 (value) and
 * SPEC-007 BR-007-06 (cost).
 */
const VALUE = 'Calculado pelo indexador contratado.';
const COST = 'O custo inclui uma subscrição cujo preço a B3 não informa.';

describe('EstimateMarker', () => {
  it('beside a value: reads "Valor estimado"', () => {
    render(<EstimateMarker kind="value" explanation={VALUE} />);
    expect(screen.getByText('Valor estimado')).toBeInTheDocument();
    expect(screen.queryByText('Custo estimado')).not.toBeInTheDocument();
  });

  it('beside a cost: reads "Custo estimado"', () => {
    render(<EstimateMarker kind="cost" explanation={COST} />);
    expect(screen.getByText('Custo estimado')).toBeInTheDocument();
    expect(screen.queryByText('Valor estimado')).not.toBeInTheDocument();
  });

  it('carries the explanation in the icon, never in a native title', () => {
    const { container } = render(<EstimateMarker kind="cost" explanation={COST} />);
    const icon = screen.getByRole('button', { name: 'Instruções sobre Custo estimado' });
    expect(icon).toHaveAccessibleDescription(COST);
    expect(container.querySelector('[title]')).toBeNull();
  });

  it('opens the explanation on keyboard focus', async () => {
    const user = userEvent.setup();
    render(<EstimateMarker kind="value" explanation={VALUE} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Instruções sobre Valor estimado' })).toHaveFocus();
    expect(screen.getByRole('note')).toHaveTextContent(VALUE);
  });

  it('opens the explanation on tap', async () => {
    const user = userEvent.setup();
    render(<EstimateMarker kind="value" explanation={VALUE} />);
    await user.click(screen.getByRole('button', { name: 'Instruções sobre Valor estimado' }));
    expect(screen.getByRole('note')).toHaveTextContent(VALUE);
  });

  it('gives each of several markers its own icon id', () => {
    render(
      <>
        <EstimateMarker kind="value" explanation={VALUE} />
        <EstimateMarker kind="value" explanation={COST} />
      </>,
    );
    const [first, second] = screen.getAllByRole('button', {
      name: 'Instruções sobre Valor estimado',
    });
    expect(first?.id).not.toBe(second?.id);
    expect(first).toHaveAccessibleDescription(VALUE);
    expect(second).toHaveAccessibleDescription(COST);
  });

  it('has no axe violations closed or open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<EstimateMarker kind="cost" explanation={COST} />);
    expect(await audit(baseElement)).toHaveNoViolations();
    await user.tab();
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
