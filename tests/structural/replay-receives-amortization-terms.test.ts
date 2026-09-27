import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-007 BR-007-05c (#166) — every production replay that can read a cost
 * is handed the ledger's amortization terms.
 *
 * How much of an amortization is returned capital depends on what the asset
 * is, and replay is pure, so the terms arrive as `ReplayOptions.amortization`.
 * A replay that omits them fails closed on the first amortization it meets
 * (`AMORTIZATION_TERMS_UNKNOWN`) — safe, but only noticed once a real ledger
 * holding one reaches that path, because test ledgers rarely do. A caller
 * that only needs a quantity uses `replayQuantity`, which needs no terms.
 *
 * So the omission is caught here instead: a call to a cost-bearing replay in
 * non-test source must mention `amortization` in its arguments.
 */

const REPLAYS = [
  'replayPosition',
  'replayPositionWithEstimate',
  'replayPositions',
  'firstUnreplayable',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !entry.name.startsWith('test-support'),
    )
    .map((entry) => join(entry.parentPath ?? dir, entry.name))
    .filter((path) => !path.includes('/test-support/'));
}

/** Every call to one of `REPLAYS` in `source` whose arguments never name the terms. */
export function replaysWithoutTerms(source: string): string[] {
  const offenders: string[] = [];
  const call = new RegExp(`(?<!function\\s)\\b(${REPLAYS.join('|')})\\(`, 'g');
  for (const match of source.matchAll(call)) {
    let depth = 1;
    let end = (match.index ?? 0) + match[0].length;
    while (depth > 0 && end < source.length) {
      const char = source[end];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += 1;
    }
    const args = source.slice((match.index ?? 0) + match[0].length, end - 1);
    if (!/\bamortization\b/.test(args)) offenders.push(`${match[1]}(${args.trim()})`);
  }
  return offenders;
}

describe('SPEC-007 BR-007-05c — cost-bearing replays receive amortization terms', () => {
  it('no production replay omits them', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      for (const call of replaysWithoutTerms(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(`${process.cwd()}/`, '')}: ${call}`);
      }
    }
    expect(
      offenders,
      'SPEC-007 BR-007-05c: pass `{ amortization }` (loadAmortizationTerms) or, for a ' +
        'quantity alone, call replayQuantity.',
    ).toEqual([]);
  });

  it('the scan fires on an omission and passes the forms the code uses', () => {
    expect(replaysWithoutTerms('const r = replayPosition(ledger);')).toHaveLength(1);
    expect(replaysWithoutTerms('firstUnreplayable([...ledger, candidate])')).toHaveLength(1);
    expect(replaysWithoutTerms('replayPositions(rows, { asOf })')).toHaveLength(1);
    expect(replaysWithoutTerms('replayPosition(project(existing), { amortization })')).toEqual([]);
    expect(
      replaysWithoutTerms(
        'replayPositionWithEstimate(f(x), { amortization: stored.amortization })',
      ),
    ).toEqual([]);
    expect(replaysWithoutTerms('export function replayPosition(\n  transactions,')).toEqual([]);
    expect(replaysWithoutTerms('const q = replayQuantity(ledger);')).toEqual([]);
  });
});
