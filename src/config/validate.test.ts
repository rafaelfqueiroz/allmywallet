import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeTx } from '@/config/test-support/fake-tx';
import { invalidateDeploymentCache } from '@/config/resolve';
import { collectConfigFailures, validateConfigOrExit } from './validate';
import { ConfigValidationError } from './errors';

/**
 * BR-002-04/DL-002-01. The real boot-time gate against real Postgres (which
 * is what actually proves an out-of-range row and `cadence_minutes = 0`
 * fail the boot, per the spec's acceptance criteria) is
 * tests/integration/config-validate.test.ts, including a real subprocess
 * that exits non-zero. This file covers `collectConfigFailures`'s own
 * assembly logic — which rows become which failures — against a fake `Tx`,
 * so that logic carries unit coverage independent of Postgres being up.
 */
describe('collectConfigFailures', () => {
  it('passes when no deployment override exists — every key uses its (valid) default', async () => {
    const tx = fakeTx({ selectRows: [] });
    const failures = await collectConfigFailures(tx);
    expect(failures).toEqual([]);
  });

  it('passes when a stored deployment override is within range', async () => {
    const tx = fakeTx({ selectRows: [{ key: 'quotes.cadence_minutes', value: 45 }] });
    const failures = await collectConfigFailures(tx);
    expect(failures).toEqual([]);
  });

  it('reports a failure for an out-of-range stored override, naming the key and value', async () => {
    const tx = fakeTx({ selectRows: [{ key: 'quotes.budget_alert_pct', value: 250 }] });
    const failures = await collectConfigFailures(tx);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.key).toBe('quotes.budget_alert_pct');
    expect(failures[0]?.error).toBeInstanceOf(ConfigValidationError);
    expect(failures[0]?.error.offendingValue).toBe(250);
    expect(failures[0]?.error.level).toBe('deployment');
  });

  it('reports quotes.cadence_minutes = 0 specifically — DL-002-01', async () => {
    const tx = fakeTx({ selectRows: [{ key: 'quotes.cadence_minutes', value: 0 }] });
    const failures = await collectConfigFailures(tx);

    const cadenceFailure = failures.find((f) => f.key === 'quotes.cadence_minutes');
    expect(cadenceFailure).toBeDefined();
    expect(cadenceFailure?.error.offendingValue).toBe(0);
  });

  it('reports every failing key, not just the first', async () => {
    const tx = fakeTx({
      selectRows: [
        { key: 'quotes.cadence_minutes', value: 0 },
        { key: 'quotes.budget_alert_pct', value: -5 },
      ],
    });
    const failures = await collectConfigFailures(tx);
    expect(failures.map((f) => f.key).sort()).toEqual(
      ['quotes.budget_alert_pct', 'quotes.cadence_minutes'].sort(),
    );
  });

  it('ignores a stored row for a key that no longer exists in the registry', async () => {
    const tx = fakeTx({ selectRows: [{ key: 'quotes.retired_key', value: 'anything' }] });
    const failures = await collectConfigFailures(tx);
    expect(failures).toEqual([]);
  });
});

describe('validateConfigOrExit', () => {
  beforeEach(() => {
    invalidateDeploymentCache();
  });

  it('primes the deployment cache and does not exit when nothing fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const tx = fakeTx({ selectRows: [] });

    await validateConfigOrExit(tx);

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('calls process.exit(1) with a message naming the key, when a stored value is invalid (BR-002-04)', async () => {
    // `process.exit` is mocked rather than called for real — otherwise this
    // test would kill the vitest worker process, and (because the mock
    // doesn't actually halt execution the way the real call does) control
    // still falls through afterwards, unlike in production. The real "does
    // the process actually die and never reach what comes after" assertion
    // lives in tests/integration/config-validate.test.ts's subprocess test.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tx = fakeTx({ selectRows: [{ key: 'quotes.cadence_minutes', value: 0 }] });

    await validateConfigOrExit(tx);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('quotes.cadence_minutes'));
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
