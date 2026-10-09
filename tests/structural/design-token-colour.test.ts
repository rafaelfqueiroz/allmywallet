import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-022 BR-022-28 / BR-022-29 / BR-022-31 — the colour claims the approved
 * palette makes, measured from `globals.css` rather than checked by eye.
 *
 * Two families of assertion:
 *
 * - **Contrast** (WCAG 2.1 §1.4.3 and §1.4.11). axe in the browser suite only
 *   measures the pairs that happen to be rendered; this measures every pair the
 *   tokens promise, in both themes, including ones no screen uses yet.
 * - **Colour-vision separation.** The navy must stay apart from the gain green,
 *   the loss red and the in-progress violet for a viewer with protanopia or
 *   deuteranopia, or a button and a figure become the same thing. Simulated
 *   with Machado, Oliveira & Fernandes (2009) at severity 1.0, applied in
 *   linear RGB, with the difference taken as Euclidean distance in OKLab.
 *
 * Every colour is converted to the sRGB a browser would actually paint —
 * clipped to gamut and quantised to 8 bits — so the numbers are the ones a user
 * sees, not the ones the oklch literal would imply on a wider-gamut display.
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)),
  'utf8',
);

function tokensIn(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`globals.css no longer contains \`${selector}\``);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const tokens = new Map<string, string>();
  for (const [, name, value] of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

const LIGHT = tokensIn(':root {');
const DARK = tokensIn('.dark {');

/** A token's value in a theme, following `var(--x)` aliases back to `:root`. */
function resolve(theme: Map<string, string>, name: string): string {
  const value = theme.get(name) ?? LIGHT.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias?.[1] ? resolve(theme, alias[1]) : value;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

/** oklch(L C H) or #rrggbb → linear sRGB, as an 8-bit display would paint it. */
function paint(value: string): Rgb {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    return [hex[1], hex[2], hex[3]].map((h) =>
      toLinear(parseInt(h ?? '0', 16) / 255),
    ) as unknown as Rgb;
  }
  const oklch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!oklch) throw new Error(`cannot measure \`${value}\``);
  const [L, C, H] = [Number(oklch[1]), Number(oklch[2]), Number(oklch[3])];
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((c) => toLinear(Math.round(toGamma(clamp(c)) * 255) / 255)) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(theme: Map<string, string>, fg: string, bg: string): number {
  const [x, y] = [luminance(paint(resolve(theme, fg))), luminance(paint(resolve(theme, bg)))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Machado, Oliveira & Fernandes (2009), Table 1, severity 1.0. */
const DEFICIENCIES: Readonly<Record<string, Matrix>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function simulate(rgb: Rgb, matrix: Matrix): Rgb {
  return matrix.map(([x, y, z]) => clamp(x * rgb[0] + y * rgb[1] + z * rgb[2])) as unknown as Rgb;
}

function separation(theme: Map<string, string>, a: string, b: string, matrix: Matrix): number {
  const [p, q] = [a, b].map((name) => oklab(simulate(paint(resolve(theme, name)), matrix)));
  return Math.hypot(p![0] - q![0], p![1] - q![1], p![2] - q![2]);
}

const THEMES = { light: LIGHT, dark: DARK } as const;

/** [foreground, background] — every text pair the tokens promise. */
const TEXT_PAIRS = [
  ['--foreground', '--background'],
  ['--foreground', '--card'],
  ['--foreground', '--popover'],
  ['--foreground', '--muted'],
  ['--foreground', '--accent'],
  ['--foreground', '--sidebar'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  // A field's placeholder on a hovered control — PR #218 review: a control
  // that hovered to a translucent `--input` fill dropped this to 4.28:1.
  ['--muted-foreground', '--accent'],
  ['--primary-foreground', '--primary'],
  ['--primary-foreground', '--primary-hover'],
  ['--primary', '--card'],
  ['--primary', '--background'],
  ['--nav-active-foreground', '--nav-active'],
  ['--destructive-foreground', '--destructive'],
  ['--positive', '--card'],
  ['--negative', '--card'],
  ['--success', '--success-surface'],
  ['--progress', '--progress-surface'],
  ['--warning', '--warning-surface'],
  ['--danger', '--danger-surface'],
  ['--neutral', '--neutral-surface'],
] as const;

/**
 * The approved minima are gain 0.160, loss 0.165, in-progress 0.035 (SPEC-022
 * Approved tokens). The floor sits below all three so the test guards against a
 * regression — a brand drifting toward one of them — without failing on the
 * approved palette. In OKLab, 0.02 is roughly a just-noticeable difference.
 */
const SEPARATION_FLOOR = 0.03;

describe('design token colour', () => {
  for (const [themeName, theme] of Object.entries(THEMES)) {
    describe(`${themeName} theme`, () => {
      it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1 (WCAG 1.4.3)', (fg, bg) => {
        expect(contrast(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
      });

      it.each(['--card', '--background'])(
        'a field boundary (--input) reaches 3:1 on %s (WCAG 1.4.11)',
        (bg) => {
          expect(contrast(theme, '--input', bg)).toBeGreaterThanOrEqual(3);
        },
      );

      for (const [deficiency, matrix] of Object.entries(DEFICIENCIES)) {
        it.each(['--positive', '--negative', '--progress'])(
          `the brand stays apart from %s under ${deficiency} (BR-022-28)`,
          (other) => {
            expect(separation(theme, '--primary', other, matrix)).toBeGreaterThan(SEPARATION_FLOOR);
          },
        );
      }
    });
  }

  // A floor that every colour clears says nothing; this one must be able to
  // fail. Two greens a hair apart are indistinguishable under any simulation.
  it('the separation measure rejects two near-identical colours', () => {
    const near = new Map([
      ['--a', 'oklch(0.5 0.14 150)'],
      ['--b', 'oklch(0.51 0.14 152)'],
    ]);
    for (const matrix of Object.values(DEFICIENCIES)) {
      expect(separation(near, '--a', '--b', matrix)).toBeLessThan(SEPARATION_FLOOR);
    }
  });
});
