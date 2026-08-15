import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-016 BR-016-05/BR-016-07a, SPEC-011 BR-011-13, TS-32 — the one
 * performance check that stays **blocking** in the PR suite rather than moving
 * to `nightly.yml`: "reports read from `DailyValuationSnapshot` and never
 * recompute from the ledger per request." Cheap because it is structural (a
 * source scan), not a timed measurement against the seeded reference workload
 * — that measurement (BR-016-03's 3s p95) is what moves to nightly; the cause
 * it predicts does not.
 *
 * **The two directories are held to different rules, on purpose.**
 *
 *  - `core/valuation/` **builds** the cache. SPEC-009 replays the ledger to
 *    produce `daily_valuation_snapshots`, so it must import the ledger — that
 *    is its job. It is checked only for reading the ledger *without* dealing
 *    in snapshots at all.
 *  - `core/reporting/` **reads** the cache, and is held to the absolute rule:
 *    no ledger import, no position replay, no `transactions` table, ever. A
 *    reporting module that imports the ledger has reintroduced the five-year
 *    replay that DL-011-07 exists to prevent, and mentioning "snapshot"
 *    elsewhere in the same file does not make that acceptable.
 *
 * No maintained list of known-good files — same reasoning as
 * `tests/isolation/enumeration.test.ts`'s database-driven enumeration: a list
 * goes stale silently, a scan does not.
 */
describe('reports read snapshots, not the ledger (SPEC-016 BR-016-05, TS-32 — blocking)', () => {
  const reportingDir = join(process.cwd(), 'src/core/reporting');
  const valuationDir = join(process.cwd(), 'src/core/valuation');

  function tsSourceFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      files.push(join(entry.parentPath ?? dir, entry.name));
    }
    return files;
  }

  /**
   * Anything that reaches the append-only ledger: the module tree, the
   * repository, and the two position use cases that replay it end to end.
   * Deliberately matches a path *segment*, so `@/core/ledger/transaction` is
   * caught as surely as `@/core/ledger` — an earlier version of this pattern
   * anchored on the end of the import path and let the former straight
   * through, which is the whole failure it exists to stop.
   */
  const LEDGER_IMPORT =
    /from\s+['"][^'"]*(\/ledger(\/|['"])|transactions?-repository|\/positions\/(replay|rebuild))/i;

  /** A raw `transactions` table read, however it is spelled. */
  const TRANSACTIONS_TABLE = /\b(from|join|into|update)\s+["'`]?transactions\b/i;

  it('has reporting and valuation source files to scan', () => {
    // Guards against the scan silently passing because it found nothing —
    // a renamed directory would otherwise turn this whole file into a no-op.
    expect(tsSourceFiles(reportingDir).length).toBeGreaterThan(0);
    expect(tsSourceFiles(valuationDir).length).toBeGreaterThan(0);
  });

  it('no reporting module imports the ledger, a transaction repository, or a replay', () => {
    const violations: string[] = [];
    for (const file of tsSourceFiles(reportingDir)) {
      const contents = readFileSync(file, 'utf8');
      if (LEDGER_IMPORT.test(contents) || TRANSACTIONS_TABLE.test(contents)) {
        violations.push(file);
      }
    }

    expect(
      violations,
      'SPEC-011 BR-011-13: core/reporting must read daily_valuation_snapshots and the position cache. ' +
        'Importing the ledger, a transaction repository or a position replay reintroduces the ' +
        'per-request five-year recomputation the snapshot table exists to prevent.',
    ).toEqual([]);
  });

  it('no valuation module reads the ledger without dealing in snapshots', () => {
    // SPEC-009 legitimately replays the ledger to BUILD snapshots, so the
    // rule here is the weaker one: a file that touches the ledger must be in
    // the snapshot business, not answering a report request directly.
    const violations: string[] = [];
    for (const file of tsSourceFiles(valuationDir)) {
      const contents = readFileSync(file, 'utf8');
      if (LEDGER_IMPORT.test(contents) && !/snapshot/i.test(contents)) violations.push(file);
    }
    expect(violations, 'BR-016-05').toEqual([]);
  });

  /**
   * The scan is only worth having if it actually fires. These two assert the
   * patterns against synthetic sources rather than against the tree, so the
   * regexes cannot rot into something that matches nothing and passes forever.
   */
  it('the ledger pattern matches every import shape a regression would use', () => {
    for (const source of [
      `import type { Transaction } from '@/core/ledger/transaction';`,
      `import { listTransactions } from '@/core/ledger';`,
      `import { replayPositions } from '@/core/positions/replay';`,
      `import { rebuildPositions } from '@/core/positions/rebuild';`,
      `import { TransactionRepository } from '@/adapters/db/transaction-repository';`,
      `import x from "../../core/ledger/ports";`,
    ]) {
      expect(LEDGER_IMPORT.test(source), source).toBe(true);
    }
  });

  it('the ledger pattern does not fire on the imports reporting legitimately uses', () => {
    for (const source of [
      `import type { DailyValuationSnapshot } from '@/core/valuation/ports';`,
      `import { Money } from '@/core/shared/money';`,
      `import { aggregate } from '@/core/reporting/base-query';`,
      `import { toCsv } from '@/lib/csv';`,
      // Not an import at all — a comment mentioning the ledger must not fail
      // the build, or the rule becomes unwritable in prose.
      `// the ledger is the source of truth; this reads the cache derived from it`,
    ]) {
      expect(LEDGER_IMPORT.test(source), source).toBe(false);
    }
    expect(TRANSACTIONS_TABLE.test(`// transactions are never read here`)).toBe(false);
    expect(TRANSACTIONS_TABLE.test(`select * from transactions`)).toBe(true);
  });
});
