import { describe, expect, it } from 'vitest';
import { PieChart } from 'recharts';
import { ChartContainer, useValueChartProps } from '@/components/charts/chart-container';
import { ChartLegend } from '@/components/charts/chart-legend';
import { assetClassColor } from '@/components/charts/palette';
import { MaskingProvider } from '@/components/patterns/masking';
import { audit, render, renderHook, screen } from '@/components/test-utils';

function Composicao() {
  return (
    <ChartContainer
      title="Composição por classe"
      summary="Ações 60%, FIIs 40%."
      legend={
        <ChartLegend
          entries={[
            { label: 'Ações', color: assetClassColor('stock'), value: '60%' },
            { label: 'FIIs', color: assetClassColor('fii'), value: '40%' },
          ]}
        />
      }
    >
      <PieChart />
    </ChartContainer>
  );
}

describe('ChartContainer', () => {
  /*
   * A chart is a picture to a screen reader — the wedges carry the whole
   * message and none of it is text. The container is where that is fixed, once,
   * rather than in each of the four reports.
   */
  it('exposes the plot as a named image', () => {
    render(<Composicao />);
    expect(screen.getByRole('img', { name: 'Composição por classe' })).toBeInTheDocument();
  });

  it('describes the image with the text summary', () => {
    render(<Composicao />);
    const plot = screen.getByRole('img', { name: 'Composição por classe' });
    const describedBy = plot.getAttribute('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Ações 60%, FIIs 40%.');
  });

  it('renders as a figure with a caption', () => {
    const { container } = render(<Composicao />);
    expect(container.querySelector('figure')).toBeInTheDocument();
    expect(container.querySelector('figcaption')?.textContent).toBe('Composição por classe');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Composicao />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('ChartLegend', () => {
  it('pairs every swatch with a text label', () => {
    render(
      <ChartLegend entries={[{ label: 'Ações', color: assetClassColor('stock'), value: '60%' }]} />,
    );
    expect(screen.getByText('Ações')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  // The swatch carries nothing the label does not; announcing it is noise.
  it('hides the colour swatch from assistive technology', () => {
    const { container } = render(
      <ChartLegend entries={[{ label: 'Ações', color: assetClassColor('stock') }]} />,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ChartLegend entries={[{ label: 'Ações', color: assetClassColor('stock') }]} />,
    );
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('useValueChartProps (SPEC-022 BR-022-24)', () => {
  const withMasking =
    (masked: boolean) =>
    ({ children }: { children: React.ReactNode }) => (
      <MaskingProvider masked={masked}>{children}</MaskingProvider>
    );

  it('adds nothing when masking is off, so the shared props decide', () => {
    const { result } = renderHook(() => useValueChartProps(), { wrapper: withMasking(false) });
    expect(result.current).toEqual({ valueAxis: {}, valueTooltip: {} });
  });

  it('labels every tick with the placeholder and keeps only the series name in the tooltip', () => {
    const { result } = renderHook(() => useValueChartProps(), { wrapper: withMasking(true) });
    const { valueAxis, valueTooltip } = result.current;

    expect(valueAxis.tickFormatter?.(123_456.78, 0)).toBe('R$ ••••••');
    expect(valueTooltip.formatter?.(123_456.78, 'Patrimônio', {} as never, 0, [])).toEqual([
      'R$ ••••••',
      'Patrimônio',
    ]);
  });
});
