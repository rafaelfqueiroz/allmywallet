import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-020 BR-020-15 / DL-020-05 — "unmet data-quality gates surface in the
 * existing 'Needs attention' queue... no second queue and no dedicated
 * onboarding panel." The dashboard's `AttentionQueue` and
 * `core/onboarding/gates.ts#describeGate` are the one place a gate is rendered
 * and the one place it is described; a second copy of either inside the
 * onboarding surface would be exactly the split-across-two-places outcome
 * DL-020-05 rejected in favour of reusing SPEC-010 BR-010-12's queue.
 *
 * `core/dashboard` is barred too, not only the two named exports: importing
 * `buildDashboardSummary` or `AttentionItem` to hand-roll a differently-shaped
 * gate list on the onboarding page would satisfy a narrower "no
 * `AttentionQueue`" check while recreating the same second panel DL-020-05
 * forbids.
 *
 * A source scan rather than a runtime assertion, in the shape of
 * `reports-read-snapshots.test.ts`: this is a structural property of *what the
 * onboarding surface may import*, not of what a rendered page contains, and a
 * scan catches it before the surface is ever rendered in a test.
 */
describe('the onboarding surface has no gate panel (SPEC-020 BR-020-15, DL-020-05)', () => {
  const scannedDirs = [
    join(process.cwd(), 'src/app/(app)/onboarding'),
    join(process.cwd(), 'src/components/onboarding'),
  ];

  function tsSourceFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      files.push(join(entry.parentPath ?? dir, entry.name));
    }
    return files;
  }

  /**
   * Only real `import ... from '...'` declarations, never a bare word — a doc
   * comment is allowed to *name* `AttentionQueue` or `describeGate` while
   * explaining why the file does not import it (this file's own module
   * comments do exactly that), and a pattern that fired on prose would make
   * that explanation itself a violation.
   */
  const IMPORT_DECLARATION = /import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g;

  /**
   * Matches an import of the queue component, the gate-description function,
   * or anything under `core/dashboard` — by path segment or named import, so
   * `@/core/dashboard/summary` is caught as surely as a bare `@/core/dashboard`.
   */
  const FORBIDDEN_IMPORT =
    /from\s+['"][^'"]*(\/dashboard\/_components\/AttentionQueue|\/core\/dashboard)(\/|['"])|\bdescribeGate\b/;

  function importViolations(contents: string): boolean {
    for (const match of contents.matchAll(IMPORT_DECLARATION)) {
      if (FORBIDDEN_IMPORT.test(match[0])) return true;
    }
    return false;
  }

  it('has onboarding source files to scan', () => {
    // Guards against the scan silently passing because a directory was
    // renamed and now resolves to nothing.
    let total = 0;
    for (const dir of scannedDirs) total += tsSourceFiles(dir).length;
    expect(total).toBeGreaterThan(0);
  });

  it('imports neither AttentionQueue, describeGate, nor core/dashboard', () => {
    const violations: string[] = [];
    for (const dir of scannedDirs) {
      for (const file of tsSourceFiles(dir)) {
        if (importViolations(readFileSync(file, 'utf8'))) violations.push(file);
      }
    }

    expect(
      violations,
      'SPEC-020 BR-020-15/DL-020-05: onboarding renders no gate list of its own. Data-quality gates ' +
        '(a missing fixed-income rate, an unclassified row, a pending allocation) surface only in the ' +
        "dashboard's \"Needs attention\" queue, described only by core/onboarding/gates.ts#describeGate " +
        'and rendered only by AttentionQueue.',
    ).toEqual([]);
  });

  /**
   * The pattern is only worth having if it actually fires — asserted against
   * synthetic sources so it cannot rot into something that matches nothing.
   */
  it('the forbidden-import pattern matches every shape a regression would use', () => {
    for (const source of [
      `import { AttentionQueue } from '@/app/(app)/dashboard/_components/AttentionQueue';`,
      `import { describeGate } from '@/core/onboarding/gates';`,
      `import type { AttentionItem } from '@/core/dashboard/summary';`,
      `import { buildDashboardSummary } from '@/core/dashboard/summary';`,
    ]) {
      expect(importViolations(source), source).toBe(true);
    }
  });

  it('does not fire on the imports the guided flow legitimately uses, nor on prose naming the same words', () => {
    for (const source of [
      `import type { OnboardingStatus } from '@/core/onboarding/status';`,
      `import { loadOnboardingStatus } from '@/app/(app)/onboarding/data';`,
      `import { UploadForm } from '@/app/(app)/import/_components/UploadForm';`,
      // A doc comment naming the forbidden imports while explaining their
      // absence must not fail the build — this file's own module comment
      // does exactly this.
      `// this page renders no AttentionQueue and calls no describeGate; gates ` +
        `surface on the dashboard's Needs attention queue instead`,
    ]) {
      expect(importViolations(source), source).toBe(false);
    }
  });
});
