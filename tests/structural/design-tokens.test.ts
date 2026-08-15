import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DL-03's three-state theming defines every dark token twice — once under
 * `@media (prefers-color-scheme: dark)` for the system default, once on `.dark`
 * for an explicit user choice. CSS gives no way to share one block between
 * them, so the duplication is structural and permanent.
 *
 * What is *not* acceptable is the two drifting: a token changed in one place
 * and not the other produces a theme that is correct until the user touches the
 * toggle, which is close to the worst possible failure mode — it passes review,
 * it passes a screenshot, and it breaks for exactly the users who went looking
 * for the setting. This test is the reason the duplication is safe to keep.
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
  'utf8',
);

/** Pulls the `--name: value` pairs out of the first block opened by `selector`. */
function tokensIn(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`globals.css no longer contains \`${selector}\``);

  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);

  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

describe('design tokens', () => {
  const light = tokensIn(':root {');
  const systemDark = tokensIn(':root:not(.light) {');
  const explicitDark = tokensIn('.dark {');

  it('defines a non-trivial number of tokens in each theme', () => {
    expect(light.size).toBeGreaterThan(20);
    expect(systemDark.size).toBeGreaterThan(20);
  });

  it('gives the system-dark and explicit-dark blocks the same token names', () => {
    expect([...explicitDark.keys()].sort()).toEqual([...systemDark.keys()].sort());
  });

  it('gives the system-dark and explicit-dark blocks the same values', () => {
    for (const [name, value] of systemDark) {
      expect(explicitDark.get(name), `${name} differs between the two dark blocks`).toBe(value);
    }
  });

  it('defines no dark-only token — every dark override has a light original', () => {
    // `color-scheme` is a real CSS property rather than a custom property, so it
    // never appears here; anything else dark-only means a light gap.
    for (const name of systemDark.keys()) {
      expect(light.has(name), `${name} is set in dark but never in light`).toBe(true);
    }
  });

  it('binds all eight Okabe–Ito chart slots (DL-04)', () => {
    for (let i = 1; i <= 8; i += 1) {
      expect(light.has(`--chart-${i}`), `--chart-${i} missing from :root`).toBe(true);
      expect(systemDark.has(`--chart-${i}`), `--chart-${i} missing from dark`).toBe(true);
    }
  });

  it('keeps positive and negative defined in both themes (DL-05)', () => {
    for (const name of ['--positive', '--negative']) {
      expect(light.has(name)).toBe(true);
      expect(systemDark.has(name)).toBe(true);
    }
  });
});
