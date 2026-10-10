import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-022 BR-022-24 — "an eye toggle masks **every** money amount."
 *
 * Masking is applied in exactly two places: `Money` from `@/app/money`, which
 * reads the account's preference on the server, and the charts' shared
 * `useValueChartProps`. An amount that reaches the screen any other way is an
 * amount the toggle cannot hide, and nothing at runtime would notice — the
 * E2E check finds `R$` followed by a digit, but a chart's raw tick or a
 * hand-formatted string need not look like that. So this holds the routes to
 * the two paths:
 *
 * 1. no page imports the design-system `Money` directly — only `MoneyMask`,
 *    the placeholder a Client Component renders for an amount the server has
 *    already masked;
 * 2. no page formats currency itself — `currencyText(masked)` is the string
 *    path, and `formatCurrency` is what it wraps;
 * 3. every chart with a value axis spreads the masking props on that axis and
 *    on its tooltip.
 *
 * The dev-only `/primitives` gallery is outside the frame and shows the
 * pattern itself, so it is exempt.
 */

const ROOT = join(__dirname, '..', '..');
const APP = join(ROOT, 'src', 'app');

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

const sources = [...files(APP)]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
  .filter(({ path }) => !path.startsWith('src/app/(dev)/'));

/**
 * A chart whose value axis is not money. `BenchmarkChart` plots growth
 * factors rebased to 100 (SPEC-012 DL-012-04) — performance, which stays
 * visible (DL-022-07).
 */
const NOT_A_MONEY_AXIS = ['src/app/(app)/reports/performance/_components/BenchmarkChart.tsx'];

describe('every amount goes through the masking (BR-022-24)', () => {
  it('finds the routes to check', () => {
    expect(
      sources.filter(({ text }) => text.includes("from '@/app/money'")).length,
    ).toBeGreaterThan(15);
  });

  it('renders Money from @/app/money, never from the pattern directly', () => {
    const offenders = sources
      .filter(({ path }) => path !== 'src/app/money.tsx')
      .filter(({ text }) => {
        const imported = /import\s*\{([^}]*)\}\s*from\s*'@\/components\/patterns\/money'/.exec(
          text,
        );
        if (!imported) return false;
        const names = imported[1]!
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
        return names.some((name) => name !== 'MoneyMask' && !name.startsWith('type '));
      })
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('never formats currency outside the masking helper', () => {
    const offenders = sources
      .filter(({ text }) => /\bformatCurrency\b/.test(text.replace(/^\s*(\*|\/\/).*$/gm, '')))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('masks the axis and the tooltip of every chart with a money axis', () => {
    const charts = sources.filter(({ text }) => text.includes('<YAxis'));
    expect(charts.length).toBeGreaterThan(5);

    const offenders = charts
      .filter(({ path }) => !NOT_A_MONEY_AXIS.includes(path))
      .filter(
        ({ text }) =>
          !/<YAxis[^>]*\{\.\.\.valueAxis\}/.test(text) ||
          !/<Tooltip[^>]*\{\.\.\.valueTooltip\}/.test(text),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
