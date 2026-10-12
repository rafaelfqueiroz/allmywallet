import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-022 BR-022-36 — "Panels use an 8 px corner radius; fields, buttons and
 * menus 6 px."
 *
 * The two steps are `rounded-lg` and `rounded-md` (`src/app/globals.css`).
 * Every larger step — the 14px `xl` step was the complaint that started
 * #236 — is barred anywhere under `src/`, on any corner or side, so a vendored
 * shadcn component cannot bring one back unnoticed. A pill is `rounded-full`.
 */

const ROOT = join(__dirname, '..', '..');

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(tsx?|css)$/.test(entry.name)) yield path;
  }
}

const sources = [...files(join(ROOT, 'src'))].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** `rounded-xl`, `rounded-t-2xl`, `rounded-se-4xl`, `--radius-xl`… */
const OVERSIZED = /(?<![\w-])(rounded(-[trblsexy]{1,2})?|--radius)-[2-9]?xl(?![\w-])/g;

describe('panel and control radii (BR-022-36)', () => {
  it('finds the sources to check', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('uses no radius above the panel step anywhere under src/', () => {
    const offenders = sources.flatMap(({ path, text }) =>
      [...text.matchAll(OVERSIZED)].map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('catches every oversized form it is meant to', () => {
    for (const sample of [
      'rounded-xl',
      'rounded-2xl',
      'rounded-t-xl',
      'rounded-se-4xl',
      '--radius-xl',
    ]) {
      expect(sample.match(OVERSIZED), sample).not.toBeNull();
    }
    for (const sample of ['rounded-lg', 'rounded-md', 'rounded-full', 'rounded-xs']) {
      expect(sample.match(OVERSIZED), sample).toBeNull();
    }
  });
});
