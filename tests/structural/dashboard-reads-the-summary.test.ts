import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-022 BR-022-07 / SPEC-016 BR-016-02 (#213) — the Dashboard **summarises**;
 * it computes nothing and reads nothing of its own.
 *
 * Its figures come from three loaders: `dashboard/data.ts` (which folds the
 * report query, the reconciliation and the queue through
 * `core/dashboard/summary.ts`), SPEC-018's `watch/data.ts` for the watch-state
 * card, and SPEC-020's `onboarding/data.ts` for the first-run redirect. The 2s
 * p95 budget (BR-016-02) is measured against those loaders, so a card that
 * reached past them — a report query, a repository, the database — would add
 * a cost the nightly budget was never measuring, and a figure the Patrimônio
 * report never agreed to (BR-013-12).
 *
 * `reports-read-snapshots.test.ts` already bars the ledger from this route;
 * this bars everything else that is not the summary.
 */

const ROOT = join(__dirname, '..', '..');
const ROUTE = join(ROOT, 'src/app/(app)/dashboard');

const ALLOWED_LOADERS = new Set([
  '@/app/(app)/dashboard/data',
  '@/app/(app)/watch/data',
  '@/app/(app)/onboarding/data',
]);

/** Anything that reads or computes data rather than presenting it. */
const FORBIDDEN = [
  /^@\/db(\/|$)/,
  /^@\/adapters\//,
  /^@\/config\//,
  /^@\/core\/(reporting|valuation|positions|ledger|quotes|ingestion|wallets)(\/|$)/,
];

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) yield path;
  }
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('the Dashboard reads the dashboard summary only (SPEC-022 BR-022-07, SPEC-016 BR-016-02)', () => {
  const renderers = [...files(ROUTE)];

  it('scans the page and its cards', () => {
    expect(renderers.map((file) => relative(ROUTE, file))).toContain('page.tsx');
    expect(renderers.length).toBeGreaterThan(1);
  });

  it('no page or card imports a repository, the database, config or a calculation module', () => {
    const violations = renderers.flatMap((file) =>
      importsOf(readFileSync(file, 'utf8'))
        .filter((spec) => FORBIDDEN.some((pattern) => pattern.test(spec)))
        .map((spec) => `${relative(ROOT, file)} imports ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it('loads data only through the dashboard, watch and onboarding loaders', () => {
    const violations = renderers.flatMap((file) =>
      importsOf(readFileSync(file, 'utf8'))
        .filter((spec) => /\/data$/.test(spec) && !ALLOWED_LOADERS.has(spec))
        .map((spec) => `${relative(ROOT, file)} imports ${spec}`),
    );
    expect(violations).toEqual([]);
  });
});
