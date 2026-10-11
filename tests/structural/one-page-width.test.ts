import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-022 BR-022-14 — "every destination shares the same left edge and
 * maximum width; a page never chooses its own."
 *
 * `PageShell` has no width prop and no `className`, so the type checker already
 * refuses the obvious way back. This covers the rest: every page in the two
 * signed-in route groups renders through `PageShell`, and no file in those
 * groups sets a maximum width, centres itself or sizes itself to the viewport.
 * A screen that wants a shorter measure for a paragraph gets it from a
 * component (`EmptyState`, `Note`), which keeps the page's edge where it is.
 *
 * The rendered edge is measured on every destination by
 * `tests/e2e/frame.spec.ts`; this is the cheap check that predicts it.
 */

const ROOT = join(__dirname, '..', '..');
const GROUPS = ['src/app/(app)', 'src/app/(settings)'];

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) yield path;
  }
}

const sources = GROUPS.flatMap((group) => [...files(join(ROOT, group))]).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/**
 * A page that does nothing but `redirect()` has nothing to put in a shell
 * (Configurações' `/settings`, which only forwards to its first section). The
 * exemption is exactly that: the whole module is imports, comments and one
 * default export whose body is a single `redirect('/…')` — a page that also
 * renders anything is not exempt, and still needs the shell.
 */
export function isRedirectOnly(text: string): boolean {
  const body = text
    .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    .replace(/^import .*$/gm, '')
    .trim();
  return /^export default (async )?function \w+\([^)]*\)(: never)? \{\s*redirect\((['"])[^'"]+\3\);?\s*\}$/.test(
    body,
  );
}

/** A width the page would be choosing for itself. */
const OWN_WIDTH = /(^|[\s"'`:])(max-w-(?!prose\b)[\w[\]().-]+|mx-auto|w-screen)(?=[\s"'`]|$)/m;

describe('one page width (BR-022-14)', () => {
  it('finds the signed-in pages to check', () => {
    expect(sources.filter(({ path }) => path.endsWith('page.tsx')).length).toBeGreaterThan(20);
  });

  it('renders every signed-in page through PageShell', () => {
    const offenders = sources
      .filter(
        ({ path, text }) =>
          path.endsWith('page.tsx') && !text.includes('<PageShell') && !isRedirectOnly(text),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('lets no file in the signed-in groups choose its own width', () => {
    const offenders = sources
      .filter(({ text }) => OWN_WIDTH.test(text))
      .map(({ path, text }) => `${path}: ${OWN_WIDTH.exec(text)?.[2] ?? ''}`);

    expect(offenders).toEqual([]);
  });

  it('exempts only a page that does nothing but redirect', () => {
    const redirectOnly = [
      "import { redirect } from 'next/navigation';",
      '/** forwards */',
      'export default function P(): never {',
      "  redirect('/settings/wallets');",
      '}',
    ].join('\n');
    expect(isRedirectOnly(redirectOnly)).toBe(true);
    // A page that renders anything else, or has no shell and no redirect, still fails.
    expect(
      isRedirectOnly(
        "export default function P() {\n  redirect('/x');\n  return <main>conteúdo</main>;\n}",
      ),
    ).toBe(false);
    expect(
      isRedirectOnly('export default function P() {\n  return <main>sem shell</main>;\n}'),
    ).toBe(false);
  });

  it('recognises the widths it bars', () => {
    expect(OWN_WIDTH.test('className="max-w-2xl"')).toBe(true);
    expect(OWN_WIDTH.test("className='mx-auto w-full'")).toBe(true);
    expect(OWN_WIDTH.test('className="sm:max-w-[40rem]"')).toBe(true);
    expect(OWN_WIDTH.test('className="max-w-prose"')).toBe(false);
  });
});
