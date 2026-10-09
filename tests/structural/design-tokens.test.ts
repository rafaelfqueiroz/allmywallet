import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** SPEC-022 BR-022-31 — the five semantic status colours. */
const STATUSES = ['success', 'progress', 'warning', 'danger', 'neutral'] as const;

/** Tokens that are not colour and so do not change with the theme. */
const THEME_INDEPENDENT = new Set(['--radius']);

function isAlias(value: string): boolean {
  return /^var\(--[\w-]+\)$/.test(value);
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

  /**
   * SPEC-022 BR-022-29 — both themes are first-class, so every value-bearing
   * token must be set in all three blocks. Two kinds are exempt by construction:
   * an alias (`--ring: var(--primary)`) follows its target into every theme and
   * re-declaring it would only create a second place to drift, and `--radius`
   * is geometry, not colour.
   */
  it('defines every non-alias light token in both dark blocks (BR-022-29)', () => {
    for (const [name, value] of light) {
      if (isAlias(value) || THEME_INDEPENDENT.has(name)) continue;
      expect(systemDark.has(name), `${name} has no system-dark value`).toBe(true);
      expect(explicitDark.has(name), `${name} has no .dark value`).toBe(true);
    }
  });

  it('never re-declares an alias in a dark block', () => {
    for (const [name, value] of light) {
      if (!isAlias(value)) continue;
      expect(systemDark.has(name), `${name} is an alias but is overridden in dark`).toBe(false);
    }
  });

  it('keeps the focus ring and the sidebar on the brand tokens (DS-06)', () => {
    expect(light.get('--ring')).toBe('var(--primary)');
    expect(light.get('--sidebar-primary')).toBe('var(--primary)');
    expect(light.get('--sidebar-accent')).toBe('var(--nav-active)');
    expect(light.get('--sidebar-ring')).toBe('var(--ring)');
  });

  it('defines the SPEC-022 tokens added by #203', () => {
    const added = [
      '--primary-hover',
      '--nav-active',
      '--nav-active-foreground',
      ...STATUSES.flatMap((s) => [`--${s}`, `--${s}-surface`]),
      '--shadow-raised',
    ];
    for (const name of added) {
      expect(light.has(name), `${name} missing from :root`).toBe(true);
      expect(systemDark.has(name), `${name} missing from dark`).toBe(true);
    }
  });

  // BR-022-33 — the active navigation fill and the focus ring are different
  // tokens with different values, in both themes.
  it('never gives the active navigation item the focus-ring colour (BR-022-33)', () => {
    for (const theme of [light, systemDark]) {
      expect(theme.get('--nav-active')).not.toBe(theme.get('--primary'));
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

  it('exposes every new colour token as a Tailwind utility', () => {
    for (const name of ['primary-hover', 'nav-active', 'nav-active-foreground', ...STATUSES]) {
      expect(css, `--color-${name} missing from @theme`).toContain(
        `--color-${name}: var(--${name});`,
      );
    }
  });
});

/**
 * SPEC-022 BR-022-31 / DS-05 — a badge is a status, never an action, so it is
 * never `destructive`; and a warning is never `negative`. A failure is `danger`,
 * an open divergence or a drift is `warning`.
 */
describe('status badges', () => {
  const appDir = fileURLToPath(new URL('../../src/app', import.meta.url));
  const files = (readdirSync(appDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.tsx'))
    // The kitchen sink renders every variant on purpose (DS-42).
    .filter((file) => !file.includes('primitives'));

  it('never renders a Badge in the destructive or negative colour', () => {
    const offenders = files.filter((file) =>
      /<Badge\b[^>]*['"](destructive|negative)['"]/s.test(readFileSync(join(appDir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
