import { describe, expect, it } from 'vitest';
import { DefaultTooltipContent, PieChart } from 'recharts';
import {
  ChartContainer,
  dateAxisProps,
  monthAxisProps,
  valueChartProps,
} from '@/components/charts/chart-container';
import { ChartLegend } from '@/components/charts/chart-legend';
import { assetClassColor } from '@/components/charts/palette';
import { audit, render, screen } from '@/components/test-utils';

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

describe('valueChartProps (SPEC-022 BR-022-38, BR-022-24)', () => {
  const NBSP = '\u00a0';
  const row = {
    date: '2026-09-30',
    value: 653_491.42,
    tip: { when: '30/09/2026', figures: { value: `R$${NBSP}653.491,42` } },
  };
  const item = (dataKey: string) => ({ dataKey, payload: row }) as never;

  it('reads the axis in abbreviated reais', () => {
    const { valueAxis } = valueChartProps(false);
    expect(valueAxis.tickFormatter?.(250_000, 0)).toBe(`R$${NBSP}250${NBSP}mil`);
    expect(valueAxis.tickFormatter?.(500, 0)).toBe(`R$${NBSP}500`);
  });

  it('reads the tooltip from the point’s server-formatted figure, never the coordinate', () => {
    const { valueTooltip } = valueChartProps(false);
    expect(valueTooltip.formatter?.(653_491.42, 'Patrimônio', item('value'), 0, [])).toEqual([
      `R$${NBSP}653.491,42`,
      'Patrimônio',
    ]);
  });

  it('drops the name of a chart’s only, unnamed series', () => {
    const { valueTooltip } = valueChartProps(false);
    expect(
      valueTooltip.formatter?.(653_491.42, 'value', item('value'), 0, [item('value')]),
    ).toEqual([`R$${NBSP}653.491,42`, undefined]);
  });

  it('heads the tooltip with the point’s date', () => {
    const { valueTooltip } = valueChartProps(false);
    expect(valueTooltip.labelFormatter?.('2026-09-30', [item('value')])).toBe('30/09/2026');
  });

  it('labels every tick and every figure with the placeholder while masked, keeping names and dates', () => {
    const { valueAxis, valueTooltip } = valueChartProps(true);

    expect(valueAxis.tickFormatter?.(123_456.78, 0)).toBe(`R$${NBSP}••••••`);
    expect(valueTooltip.formatter?.(80, 'Patrimônio', item('value'), 0, [])).toEqual([
      `R$${NBSP}••••••`,
      'Patrimônio',
    ]);
    expect(valueTooltip.labelFormatter?.('2026-09-30', [item('value')])).toBe('30/09/2026');
  });
});

/**
 * The tooltip as Recharts paints it, from the props `valueChartProps` hands it
 * — the date heading the point and the server-formatted figure beside the
 * series' name.
 */
describe('a money chart’s tooltip (SPEC-022 BR-022-38)', () => {
  const row = {
    month: '2026-09',
    amount: 1284.1,
    average: 1100.5,
    tip: {
      when: 'setembro de 2026',
      figures: { amount: 'R$\u00a01.284,10', average: 'R$\u00a01.100,50' },
    },
  };
  const payload = [
    { dataKey: 'amount', name: 'Proventos', value: 1284.1, payload: row },
    { dataKey: 'average', name: 'Média de 12 meses', value: 1100.5, payload: row },
  ];

  function Tip({ masked }: { readonly masked: boolean }) {
    return (
      <DefaultTooltipContent
        label="2026-09"
        payload={payload as never}
        {...valueChartProps(masked).valueTooltip}
      />
    );
  }

  it('reads the date and each series’ exact amount with centavos', () => {
    const { container } = render(<Tip masked={false} />);
    const text = container.textContent?.replaceAll('\u00a0', ' ');

    expect(text).toContain('setembro de 2026');
    expect(text).toContain('Proventos : R$ 1.284,10');
    expect(text).toContain('Média de 12 meses : R$ 1.100,50');
    // Never the coordinate.
    expect(text).not.toContain('1284.1');
  });

  it('keeps the date and the names and hides every figure while masked', () => {
    const { container } = render(<Tip masked />);
    const text = container.textContent?.replaceAll('\u00a0', ' ');

    expect(text).toContain('setembro de 2026');
    expect(text).toContain('Proventos : R$ ••••••');
    expect(text).not.toContain('1.284,10');
  });
});

describe('date axes (SPEC-022 BR-022-42)', () => {
  const days = (from: string, to: string): { date: string }[] => {
    const out: { date: string }[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`);) {
      out.push({ date: d.toISOString().slice(0, 10) });
      d = new Date(d.getTime() + 86_400_000);
    }
    return out;
  };

  it('ticks a daily series once per month, as month and year', () => {
    const { ticks, tickFormatter } = dateAxisProps(days('2025-11-15', '2026-02-10'));
    expect(ticks).toEqual(['2025-11-15', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(ticks?.map((tick, index) => tickFormatter?.(tick, index))).toEqual([
      'nov/25',
      'dez/25',
      'jan/26',
      'fev/26',
    ]);
  });

  it('ticks a range of under three months by day, leaving the spacing to Recharts', () => {
    const props = dateAxisProps(days('2026-08-20', '2026-09-30'));
    expect(props.ticks).toBeUndefined();
    expect(props.tickFormatter?.('2026-09-30', 0)).toBe('30/09');
  });

  it('ticks a monthly series as the month alone', () => {
    expect(monthAxisProps.tickFormatter('2026-09')).toBe('set');
  });
});
