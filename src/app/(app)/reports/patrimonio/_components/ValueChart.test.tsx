import { cloneElement, type ReactElement } from 'react';
import type * as Recharts from 'recharts';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@/components/test-utils';
import { ValueChart } from './ValueChart';

/**
 * SPEC-021 BR-021-31 — a gap day is a *break* in the value line, never a
 * bridge between its neighbours.
 *
 * jsdom has no layout, so Recharts' `ResponsiveContainer` measures 0×0 and
 * draws nothing. It is replaced here with a fixed 600×300 frame so the real
 * `AreaChart` renders real SVG paths — the geometry is what this test reads.
 *
 * A Recharts curve path starts each continuous segment with an `M` (moveTo).
 * One segment → one `M`; a null point that breaks the line → two. With
 * `connectNulls` on, or with the gap day not nulled, the line is continuous and
 * this test fails.
 */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children as ReactElement<{ width: number; height: number }>, {
        width: 600,
        height: 300,
      }),
  };
});

function lineSegments(container: HTMLElement): number {
  const curve = container.querySelector('path.recharts-area-curve');
  const d = curve?.getAttribute('d') ?? '';
  return (d.match(/M/g) ?? []).length;
}

describe('ValueChart geometry (SPEC-021 BR-021-31)', () => {
  it('draws a continuous line when no day is a gap', () => {
    const { container } = render(
      <ValueChart
        title="Patrimônio"
        summary="—"
        points={[
          { date: '2026-03-12', value: 3720, estimated: false },
          { date: '2026-03-13', value: 3510, estimated: false },
          { date: '2026-03-16', value: 3865, estimated: false },
          { date: '2026-03-17', value: 3865, estimated: false },
        ]}
      />,
    );
    expect(lineSegments(container)).toBe(1);
  });

  it('breaks the line at a gap day instead of joining its neighbours', () => {
    const { container } = render(
      <ValueChart
        title="Patrimônio"
        summary="—"
        points={[
          { date: '2026-03-12', value: 3720, estimated: false },
          { date: '2026-03-13', value: 3510, estimated: false },
          { date: '2026-03-16', value: null, estimated: false, gap: true },
          { date: '2026-03-17', value: 3865, estimated: false },
          { date: '2026-03-18', value: 3900, estimated: false },
        ]}
      />,
    );
    expect(lineSegments(container)).toBe(2);
  });
});
