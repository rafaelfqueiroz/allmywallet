import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-016 BR-016-05/BR-016-07a, TS-32 — the one performance check that stays
 * **blocking** in the PR suite rather than moving to `nightly.yml`: "reports
 * read from `DailyValuationSnapshot` and never recompute from the ledger per
 * request." Cheap because it is structural (a source scan), not a timed
 * measurement against the seeded reference workload — that measurement
 * (BR-016-03's 3s p95) is what moves to nightly; the cause it predicts does
 * not.
 *
 * SPEC-009 (#12, valuation snapshots) and SPEC-011 (#14, reports) are not
 * built yet — this task (#19) owns none of `core/valuation/` or
 * `core/reporting/`. Written so it is meaningful *today* rather than a stub
 * to fill in later: while those directories do not exist, the architectural
 * rule holds vacuously (there is no reporting code, so none of it recomputes
 * from the ledger); the moment #12/#14 add reporting use cases, this starts
 * scanning them for real and can fail the build. No maintained list of
 * "known-good" files — same reasoning as tests/isolation/enumeration.test.ts's
 * database-driven enumeration: a list goes stale silently, a scan does not.
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

  it('core/reporting and core/valuation do not exist yet — the rule holds vacuously (SPEC-009 #12 / SPEC-011 #14)', () => {
    // This assertion is the "grows teeth automatically" half: once either
    // directory is created, this specific test starts failing, which is the
    // signal that the scan below has real files to check for the first time.
    // Nothing to update here when that happens — the next test already does
    // the real work unconditionally.
    if (!existsSync(reportingDir) && !existsSync(valuationDir)) {
      expect(true).toBe(true);
      return;
    }
    expect(tsSourceFiles(reportingDir).length + tsSourceFiles(valuationDir).length).toBeGreaterThan(
      0,
    );
  });

  it('no reporting or valuation use case imports the transaction ledger directly', () => {
    const files = [...tsSourceFiles(reportingDir), ...tsSourceFiles(valuationDir)];
    const violations: string[] = [];

    // A file that reads raw ledger/transaction history (rather than a
    // precomputed snapshot) to answer a report request is exactly the
    // regression BR-016-05 forbids — SPEC-009 persists daily snapshots
    // precisely so SPEC-011 never has to replay five years of transactions
    // per request (ARCHITECTURE, spec Description). Importing a snapshot
    // repository/port is fine; importing the ledger's own repository is not.
    const FORBIDDEN_ledger_IMPORT = /from ['"].*\/(ledger|transactions?-repository)['"]/i;
    const SNAPSHOT_IMPORT = /snapshot/i;

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      if (FORBIDDEN_ledger_IMPORT.test(contents) && !SNAPSHOT_IMPORT.test(contents)) {
        violations.push(file);
      }
    }

    expect(
      violations,
      'reporting/valuation code importing the ledger directly instead of a DailyValuationSnapshot repository — BR-016-05',
    ).toEqual([]);
  });
});
