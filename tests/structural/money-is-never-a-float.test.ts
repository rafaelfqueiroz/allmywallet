import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-006's last acceptance criterion: "**No monetary value is stored or
 * computed in floating point, verified by schema and code inspection.**"
 *
 * The *code* half is already mechanical — `eslint.config.mjs` bans
 * `parseFloat`, `parseInt` and `Math.round` across `core/` and `adapters/`
 * (AR-06/AR-09). This is the *schema* half, which nothing checked.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCHEMA CHECK IS WORTH HAVING SEPARATELY
 *
 * A `real` or `double precision` column is the one way a float can enter the
 * product without a single float appearing in TypeScript. Every value would
 * round-trip through `Money` correctly, every unit test would pass, and the
 * loss would happen inside Postgres — 0,1 + 0,2 stored as a double is not
 * 0,3, and an average cost accumulated over hundreds of transactions drifts
 * away from the broker's number with nothing in the code to point at.
 *
 * DL-006-05 is explicit that this is unfixable after the fact without a full
 * rebuild, which is exactly the class of mistake worth a blocking test rather
 * than a review comment.
 * ---------------------------------------------------------------------------
 */

const ROOT = process.cwd();

function filesUnder(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    found.push(join(entry.parentPath ?? dir, entry.name));
  }
  return found;
}

/**
 * Drizzle's float column builders. `numeric` is absent on purpose — it is the
 * *correct* one, and `src/db/numeric.ts` wraps it as `money`/`quantity`/`rate`.
 */
const FLOAT_BUILDERS = /\b(real|doublePrecision)\s*\(/g;

/**
 * The SQL spellings, including the aliases Postgres accepts.
 *
 * Both boundaries matter: without the trailing `\b`, `real` matches the first
 * four letters of `realized_gain numeric(20,8)` — a correctly typed column —
 * and the check reports the very thing it exists to approve.
 */
const FLOAT_SQL = /\b(real|double\s+precision|float4|float8|float)\b/gi;

/**
 * Comments are stripped before the scan. `0008_valuation_snapshots.sql`
 * explains in prose why a `Decimal` must not cross a JSON boundary — it
 * contains the word "float" precisely because it is being careful, and a
 * checker that flags the explanation teaches people to delete the comment.
 */
function withoutSqlComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('money never becomes a float, in the schema either (blocking)', () => {
  it('declares no floating-point column in any Drizzle schema', () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(ROOT, 'src/db/schema'), '.ts')) {
      const body = readFileSync(file, 'utf8');
      for (const match of body.matchAll(FLOAT_BUILDERS)) {
        offenders.push(`${file.replace(`${ROOT}/`, '')}: ${match[1]}()`);
      }
    }
    // Named rather than counted — a count says something broke, a name says
    // which column and which spec's numbers it corrupts.
    expect(offenders).toEqual([]);
  });

  it('creates no floating-point column in any migration', () => {
    // The schema and the migrations can disagree: migrations are hand-written
    // forward-only SQL (AR-69), so a column added there is not necessarily
    // visible in the Drizzle schema at all.
    const offenders: string[] = [];
    for (const file of filesUnder(join(ROOT, 'src/db/migrations'), '.sql')) {
      const body = withoutSqlComments(readFileSync(file, 'utf8'));
      for (const match of body.matchAll(FLOAT_SQL)) {
        offenders.push(`${file.replace(`${ROOT}/`, '')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans a schema directory that actually exists', () => {
    // The failure mode of every path-based scan: the directory is renamed, the
    // glob matches nothing, and the check passes forever while checking
    // nothing. Both scans above are worthless without this one.
    expect(filesUnder(join(ROOT, 'src/db/schema'), '.ts').length).toBeGreaterThan(5);
    expect(filesUnder(join(ROOT, 'src/db/migrations'), '.sql').length).toBeGreaterThan(5);
  });
});
