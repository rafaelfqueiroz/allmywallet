import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  REGISTRY,
  USER_SETTABLE_KEYS,
  isConfigKey,
  registryEntry,
  type ConfigKey,
} from './registry';

describe('registry', () => {
  it('has exactly the 22 keys from the SPEC-002 initial registry table, plus later additions', () => {
    // 18 keys from SPEC-002's own table, plus three SPEC-016 additions:
    // `alerts.queue_backlog_threshold` (BR-016-13/BR-016-14: thresholds are
    // config, not code) and the two `observability.worker_heartbeat_*`
    // cadence/threshold keys behind AR-50's health endpoint; plus one SPEC-011
    // addition, `reports.default_grouping_wallet_scope` — BR-011-04 specifies
    // a different default grouping inside a wallet and says both are
    // user-configurable, which one key cannot express.
    expect(CONFIG_KEYS).toHaveLength(22);
  });

  it('every entry’s own key field matches the object key it is stored under (guards against copy/paste typos)', () => {
    for (const key of CONFIG_KEYS) {
      expect(REGISTRY[key].key).toBe(key);
    }
  });

  // BR-002-04: "every key declares a type and permitted range". A default
  // that fails its own schema would make every deployment boot-fail on day
  // one — this is the safety net for that.
  it('every default value satisfies its own schema', () => {
    for (const key of CONFIG_KEYS) {
      const entry = REGISTRY[key];
      const result = entry.schema.safeParse(entry.default);
      expect(result.success, `default for "${key}" must satisfy its own schema`).toBe(true);
    }
  });

  it('quotes.cadence_minutes rejects 0 — DL-002-01: never silently "poll continuously"', () => {
    const result = REGISTRY['quotes.cadence_minutes'].schema.safeParse(0);
    expect(result.success).toBe(false);
  });

  it('every entry declares at least one permitted level', () => {
    for (const key of CONFIG_KEYS) {
      expect(REGISTRY[key].levels.length).toBeGreaterThan(0);
    }
  });

  it('isConfigKey narrows only real registry keys', () => {
    expect(isConfigKey('quotes.cadence_minutes')).toBe(true);
    expect(isConfigKey('not.a.real.key')).toBe(false);
  });

  it('USER_SETTABLE_KEYS is derived from the registry, not hand-maintained', () => {
    const expected = CONFIG_KEYS.filter((key) => registryEntry(key).levels.includes('user'));
    expect(USER_SETTABLE_KEYS).toEqual(expected);
    // Matches the spec table's "User" / "Deployment / user" rows exactly.
    expect(USER_SETTABLE_KEYS).toEqual([
      'import.staleness_days',
      'import.reminder_enabled',
      'reports.concentration_threshold_pct',
      'reports.default_grouping',
      // SPEC-011 BR-011-04: the wallet-scope default is a second, separately
      // configurable key — "both are user-configurable".
      'reports.default_grouping_wallet_scope',
      'reports.benchmarks',
    ] satisfies ConfigKey[]);
  });

  it('no key in the registry is a plausible secret name (AR-43/BR-002-08 — secrets never enter the registry)', () => {
    const secretLike = /secret|password|token|dsn|credential/i;
    for (const key of CONFIG_KEYS) {
      expect(secretLike.test(key)).toBe(false);
    }
  });

  // AC: "Grepping the codebase for the registry's default values finds them
  // only in the registry definition." Checked against defaults distinctive
  // enough that a match elsewhere in src/ is meaningful rather than a
  // coincidence — `true`, `false`, `30` or `10` appear all over the codebase
  // for unrelated reasons and would make this test pure noise.
  it('static: distinctive default values appear only in registry.ts', () => {
    // quotes.monthly_quota (15000) and quotes.provider ('brapi_free') are
    // distinctive enough that a match elsewhere is meaningful. Small ints
    // (10, 12, 20, 30, 70, 100) and booleans are excluded deliberately —
    // they occur throughout the codebase for unrelated reasons and would
    // make this check pure noise rather than a real signal.
    for (const needle of ['15000', 'brapi_free']) {
      const matches = grepSrcExcludingRegistry(needle);
      expect(
        matches,
        `"${needle}" must appear only in src/config/registry.ts, found in:\n${matches.join('\n')}`,
      ).toEqual([]);
    }
  });
});

function grepSrcExcludingRegistry(needle: string): string[] {
  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' -F ${JSON.stringify(needle)} src`,
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    return output
      .split('\n')
      .filter(Boolean)
      .filter((path) => !path.endsWith('src/config/registry.ts') && !path.includes('.test.'));
  } catch (error) {
    // grep exits 1 when there are no matches at all — that is a pass, not a failure.
    const execError = error as { status?: number };
    if (execError.status === 1) return [];
    throw error;
  }
}
