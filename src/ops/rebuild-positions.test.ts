import { describe, expect, it } from 'vitest';
import { parseArgs } from '@/ops/rebuild-positions';

/**
 * SPEC-007 BR-007-14 — the repair command's argument handling.
 *
 * Worth its own test because the failure mode is asymmetric: refusing a valid
 * invocation wastes an operator's minute, while *accepting* an ambiguous one
 * rebuilds every tenant's positions in production, where there is no staging
 * environment and no undo. There is deliberately no implicit default.
 */

const USER = '01920000-0000-7000-8000-00000000a001';

const isUsage = (result: ReturnType<typeof parseArgs>): result is { readonly usage: string } =>
  'usage' in result;

describe('parseArgs', () => {
  it('accepts a single tenant by id', () => {
    const parsed = parseArgs(['--user', USER]);
    expect(isUsage(parsed)).toBe(false);
    if (isUsage(parsed)) return;
    expect(parsed.userId).toBe(USER);
    expect(parsed.all).toBeUndefined();
    expect(parsed.dryRun).toBe(false);
  });

  it('accepts every tenant, explicitly', () => {
    const parsed = parseArgs(['--all']);
    expect(isUsage(parsed)).toBe(false);
    if (isUsage(parsed)) return;
    expect(parsed.all).toBe(true);
    expect(parsed.userId).toBeUndefined();
  });

  it('carries --dry-run through either form', () => {
    for (const argv of [
      ['--user', USER, '--dry-run'],
      ['--all', '--dry-run'],
    ]) {
      const parsed = parseArgs(argv);
      expect(isUsage(parsed)).toBe(false);
      if (isUsage(parsed)) continue;
      expect(parsed.dryRun).toBe(true);
    }
  });

  it.each([
    ['no arguments at all', []],
    ['--user with no id', ['--user']],
    ['--user and --all together', ['--user', USER, '--all']],
    ['an id that is not a UUID', ['--user', 'not-a-uuid']],
    ['only --dry-run, with no scope', ['--dry-run']],
  ])('prints usage rather than guessing: %s', (_label, argv) => {
    const parsed = parseArgs(argv);
    // Every one of these could plausibly be read as "all tenants". None is.
    expect(isUsage(parsed)).toBe(true);
  });

  it('rejects a malformed id before it reaches UserId.of', () => {
    // `UserId.of` throws; an operator typo should print usage, not a stack.
    expect(() => parseArgs(['--user', '1; DROP TABLE users'])).not.toThrow();
    expect(isUsage(parseArgs(['--user', '1; DROP TABLE users']))).toBe(true);
  });
});
