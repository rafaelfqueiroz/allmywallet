import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { PARAMETER_SURFACES, USER_SETTABLE_KEYS } from '@/config/registry';

/**
 * `ParameterForm` renders one field per user-settable key and looks its copy
 * up as `parameters.keys.<key>.label`. next-intl reads every `.` in that path
 * as nesting, so a catalogue holding `"reports.benchmarks"` as one flat key
 * never resolves: the page shows the raw message id instead. That stayed
 * invisible while no signed-in session could reach the page. BR-002-01 adds a
 * field for every new `levels: [..., 'user']` key with no other change, so
 * this is the check that the copy arrived with it.
 */
function lookup(path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, segment) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    messages.parameters.keys,
  );
}

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

describe('parameter catalogue', () => {
  it.each(USER_SETTABLE_KEYS)('%s has a nested label and description', (key) => {
    const segments = key.split('.');
    expect(lookup([...segments, 'label'])).toEqual(expect.any(String));
    expect(lookup([...segments, 'description'])).toEqual(expect.any(String));
  });

  /*
   * SPEC-022 BR-022-13 / DESIGN.md DS-30 — "adding a new registry key needs no
   * screen change". A key reaches a screen through its `surface` alone, which
   * holds only while every surface is mounted by exactly one page.
   * `registry.test.ts` checks every user-level key has a surface; this checks
   * every surface has a screen.
   */
  const pages = pageFiles(join(process.cwd(), 'src/app')).map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }));

  it.each(PARAMETER_SURFACES)('surface %s is rendered by exactly one page', (surface) => {
    const mounts = pages.filter(({ source }) => source.includes(`surface="${surface}"`));
    expect(mounts.map(({ path }) => path)).toHaveLength(1);
  });
});
