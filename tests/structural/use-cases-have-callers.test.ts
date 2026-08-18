import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **A use case with no caller passes every test it has.**
 *
 * That sentence is the whole reason this file exists. Eight times now, a
 * `core/` use case has been written, unit-tested, ticked as done on a board
 * issue, and reached by nothing — so the business rule it implements never
 * held at runtime while every signal said it did:
 *
 *  - `applyBuy`/`applySell`/`applyCorporateEventToAllocations` (#13) — a sale
 *    shrank the position and left allocations untouched, so BR-010-05 was
 *    violable by any sell of a fully-allocated asset.
 *  - `SnapshotJobPayload.from` (#12) — a backdated import left the chart
 *    showing last night's shape until a nightly sweep rebuilt everything.
 *  - The valuation metadata on `ReportPosition` (#12) — a suspended stock
 *    rendered indistinguishably from a live quote.
 *  - `deleteTransaction`, `bulkDeleteTransactions` and `describeDeletionImpact`
 *    (#9) — SPEC-006's whole transaction-management surface had no route, so
 *    BR-006-11..17 held in unit tests and nowhere else. Wired now; the entries
 *    below came out because the second test insisted.
 *  - `rebuildPositions` and the two snapshot rebuild entry points — still
 *    orphaned, see the baseline.
 *
 * Each was found by a human reading code, twice by a full acceptance-criteria
 * sweep. This scan found them in one pass, and found two the sweeps missed.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A USE CASE
 *
 * By this codebase's convention an application service is
 * `fn(deps, userId, input)` — it takes a dependencies object first. That is a
 * precise signal and it is why this scan is worth having at all: a broader
 * rule ("any exported function with no caller") reports 47 symbols on this
 * repository, nearly all of them legitimate — `isOk`, `typeRank`, `isLeapYear`,
 * test-support builders. A check with 47 false positives is one nobody reads.
 *
 * Helpers, predicates and pure calculations are therefore deliberately out of
 * scope. They are allowed to be unused; a use case is not, because a use case
 * *is* a business rule and an unreachable one is a rule that does not hold.
 * ---------------------------------------------------------------------------
 */

const ROOT = process.cwd();

/**
 * Tests and their fixtures are not callers. That is the entire point — the
 * defect this catches is precisely "tests call it, nothing else does".
 */
function isTestFile(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx') || file.includes('test-support');
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    found.push(join(entry.parentPath ?? dir, entry.name));
  }
  return found;
}

/**
 * `export async function name(deps` — optionally with a comment between the
 * paren and the parameter, which several use cases have.
 *
 * `.tsx` is scanned for callers as well as `.ts`: an earlier version of this
 * scan looked only at `.ts` and reported every use case a Server Component
 * calls as an orphan, because pages are `.tsx`.
 */
const USE_CASE = /export\s+async\s+function\s+(\w+)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?deps\b/g;

/**
 * Use cases that are knowingly unreachable today, each naming the issue that
 * will wire it. **This list is checked in both directions** (see the second
 * test below): an entry that is no longer orphaned fails the suite, so it
 * cannot quietly outlive the fix it was waiting for.
 *
 * That two-way check is what makes a list acceptable here at all. The other
 * structural checks in this directory refuse maintained lists outright —
 * "a list goes stale silently, a scan does not" — and they are right about
 * one-way lists. The alternative was to grandfather every existing orphan
 * invisibly, which would have hidden the finding that produced #9's reopening:
 * SPEC-006's entire transaction-management surface has no route.
 */
const KNOWN_ORPHANS: ReadonlyMap<string, string> = new Map([
  // #10 — DM-4's repair mechanism. Its own progress log says "Full rebuild
  // command" is unticked; the issue was closed anyway and is now reopened.
  ['rebuildPositions', '#10'],
  // #12 — the valuation worker uses `computeSnapshots`/`persistSnapshots`
  // instead; these two are dead alternates rather than a missing surface, so
  // the fix may well be deletion rather than wiring.
  ['rebuildSnapshots', '#12'],
  ['invalidateSnapshotsFrom', '#12'],
  // #13 — a helper that outlived its caller; `pending.ts` computes the same
  // count locally in `walletCountFor`.
  ['walletsHoldingCount', '#13'],
]);

function orphanedUseCases(): string[] {
  const core = sourceFiles(join(ROOT, 'src/core')).filter((file) => !isTestFile(file));
  const production = sourceFiles(join(ROOT, 'src')).filter((file) => !isTestFile(file));
  const bodies = new Map(production.map((file) => [file, readFileSync(file, 'utf8')]));

  const orphans: string[] = [];
  for (const file of core) {
    for (const match of (bodies.get(file) ?? '').matchAll(USE_CASE)) {
      const name = match[1];
      if (name === undefined) continue;
      const reachable = production.some(
        (other) => other !== file && new RegExp(`\\b${name}\\b`).test(bodies.get(other) ?? ''),
      );
      if (!reachable) orphans.push(name);
    }
  }
  return orphans;
}

describe('every core use case is reachable from the application (blocking)', () => {
  it('has no unreachable use case outside the recorded baseline', () => {
    const unexpected = orphanedUseCases().filter((name) => !KNOWN_ORPHANS.has(name));

    // Named rather than counted: a count says "something broke", a name says
    // which rule stopped holding and where to look.
    expect(unexpected).toEqual([]);
  });

  it('has no baseline entry that is already wired', () => {
    const orphans = new Set(orphanedUseCases());
    const stale = [...KNOWN_ORPHANS.keys()].filter((name) => !orphans.has(name));

    // The direction a one-way allow-list rots in: something gets fixed, the
    // entry stays, and the next orphan with that name is tolerated silently.
    expect(stale).toEqual([]);
  });
});
