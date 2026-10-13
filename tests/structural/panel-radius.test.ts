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

/** A radius written as a literal rather than a step — DS-04. */
const ARBITRARY = /(?<![\w-])rounded(-[trblsexy]{1,2})?-(?:\[[^\]]*\]|\([^)]*\))/g;

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The radius class on each primitive's own root, by its role. */
const CONTROLS = [
  'src/components/ui/button.tsx',
  'src/components/ui/input.tsx',
  'src/components/ui/native-select.tsx',
  'src/components/ui/select.tsx',
  'src/components/ui/popover.tsx',
  'src/components/ui/dropdown-menu.tsx',
  'src/components/patterns/color-input.tsx',
];
const PANELS = [
  'src/components/ui/card.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/patterns/section.tsx',
];

describe('panel and control radii (BR-022-36)', () => {
  it('pins the panel step at 8px and the control step at 6px', () => {
    const css = read('src/app/globals.css');
    expect(css).toMatch(/^\s*--radius: 0\.5rem;/m);
    expect(css).toMatch(/^\s*--radius-lg: var\(--radius\);/m);
    expect(css).toMatch(/^\s*--radius-md: 0\.375rem;/m);
  });

  it('draws fields, buttons and menus at the control step, never the panel step', () => {
    for (const path of CONTROLS) {
      const text = read(path);
      expect(text, path).toMatch(/\brounded-md\b/);
      expect(text, path).not.toMatch(/(?<![\w-])rounded-lg(?![\w-])/);
    }
  });

  it('draws panels at the panel step', () => {
    for (const path of PANELS) {
      expect(read(path), path).toMatch(/\brounded-lg\b/);
    }
  });

  it('writes no radius as a literal value', () => {
    const offenders = sources.flatMap(({ path, text }) =>
      [...text.matchAll(ARBITRARY)].map((match) => `${path}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('rejects arbitrary variable syntax as well as literal radii', () => {
    for (const sample of ['rounded-(--radius-xl)', 'rounded-t-(--custom)', 'rounded-[12px]']) {
      expect(sample.match(ARBITRARY), sample).not.toBeNull();
    }
  });

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
