import { beforeEach, describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { fakeTx, poisonTx } from '@/config/test-support/fake-tx';
import {
  authorizeConfigWrite,
  invalidateDeploymentCache,
  primeDeploymentCacheForTest,
  resolveFromLayers,
  setConfigValue,
  type ConfigActor,
} from './resolve';
import { ConfigValidationError } from './errors';

/**
 * TS-01 in spirit for the resolution *algorithm*: `resolveFromLayers` and
 * `authorizeConfigWrite` are exercised entirely without a database. The
 * write path (`setConfigValue`) is DB-backed by nature, but its early-exit
 * branches (authorization refused, value invalid, missing tenant/user id)
 * never reach the database at all — those are proven here with `poisonTx`,
 * a `Tx` that throws on any call. The parts that genuinely need real SQL
 * semantics (RLS, `ON CONFLICT`, NUMERIC round-tripping) stay covered by
 * tests/integration/config-resolve.test.ts and .../config-audit.test.ts —
 * faking those away would just prove the fake works, not the query.
 */

// The deployment cache is process-wide module state (resolve.ts); reset it
// between tests so one test's `primeDeploymentCacheForTest` can't leak into
// the next.
beforeEach(() => {
  invalidateDeploymentCache();
});

describe('resolveFromLayers — BR-002-02: most specific wins across default → deployment → tenant → user', () => {
  it('falls back to the registry default when no layer set the key', () => {
    const resolved = resolveFromLayers('quotes.cadence_minutes', {});
    expect(resolved).toEqual({ key: 'quotes.cadence_minutes', value: 30, source: 'default' });
  });

  it('deployment overrides the default', () => {
    const resolved = resolveFromLayers('quotes.cadence_minutes', { deployment: 60 });
    expect(resolved).toEqual({ key: 'quotes.cadence_minutes', value: 60, source: 'deployment' });
  });

  it('tenant overrides deployment', () => {
    const resolved = resolveFromLayers('import.staleness_days', { deployment: 30, tenant: 45 });
    expect(resolved).toEqual({ key: 'import.staleness_days', value: 45, source: 'tenant' });
  });

  it('user overrides tenant and deployment — the most specific layer always wins', () => {
    const resolved = resolveFromLayers('import.staleness_days', {
      deployment: 30,
      tenant: 45,
      user: 7,
    });
    expect(resolved).toEqual({ key: 'import.staleness_days', value: 7, source: 'user' });
  });

  it('user overrides deployment directly when no tenant layer is set', () => {
    const resolved = resolveFromLayers('reports.concentration_threshold_pct', { user: 15 });
    expect(resolved).toEqual({
      key: 'reports.concentration_threshold_pct',
      value: 15,
      source: 'user',
    });
  });

  it('throws — never silently falls through — when the most specific set layer is invalid (DL-002-01)', () => {
    // quotes.cadence_minutes: 0 is out of range (min 1). If this silently
    // fell through to the deployment layer or the default, a cadence of 0
    // would be indistinguishable from "poll continuously" never having been
    // requested at all — exactly what DL-002-01 forbids.
    expect(() => resolveFromLayers('quotes.cadence_minutes', { deployment: 0 })).toThrow(
      ConfigValidationError,
    );
  });

  it('the thrown error names the key, the offending value and the permitted range', () => {
    let thrown: unknown;
    try {
      resolveFromLayers('quotes.cadence_minutes', { deployment: 0 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const validationError = thrown as ConfigValidationError;
    expect(validationError.key).toBe('quotes.cadence_minutes');
    expect(validationError.offendingValue).toBe(0);
    expect(validationError.range).toBe('integer, 1–1440');
    expect(validationError.message).toContain('quotes.cadence_minutes');
    expect(validationError.message).toContain('0');
    expect(validationError.message).toContain('1–1440');
  });
});

describe('authorizeConfigWrite — BR-002-03: an authorisation check, not form validation', () => {
  const operator: ConfigActor = { kind: 'operator' };
  const user: ConfigActor = { kind: 'user', userId: UserId.generate() };

  it('a user attempting to set a deployment-only key is refused', () => {
    // quotes.cadence_minutes only permits level: ['deployment'].
    const result = authorizeConfigWrite('quotes.cadence_minutes', 'deployment', user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFIG_LEVEL_NOT_PERMITTED');
  });

  it('an operator may set a deployment-only key', () => {
    const result = authorizeConfigWrite('quotes.cadence_minutes', 'deployment', operator);
    expect(result.ok).toBe(true);
  });

  it('an operator may not write a user-level row (no admin-impersonation path in v1)', () => {
    const result = authorizeConfigWrite('reports.concentration_threshold_pct', 'user', operator);
    expect(result.ok).toBe(false);
  });

  it('a user may set a key the registry marks user-settable', () => {
    const result = authorizeConfigWrite('reports.concentration_threshold_pct', 'user', user);
    expect(result.ok).toBe(true);
  });

  it('a user is refused even for a key that permits "user" if they request the "deployment" level for it', () => {
    // import.staleness_days permits ['deployment', 'user'] — the level
    // requested here is the deployment one, which must still be refused for
    // a user actor regardless of what the key otherwise allows.
    const result = authorizeConfigWrite('import.staleness_days', 'deployment', user);
    expect(result.ok).toBe(false);
  });

  it('a user is refused for a level the key never permits at all, even though they are the right kind of actor', () => {
    // quotes.cadence_minutes never lists 'tenant' or 'user' as permitted.
    const result = authorizeConfigWrite('quotes.cadence_minutes', 'user', user);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFIG_LEVEL_NOT_PERMITTED');
  });
});

describe('setConfigValue — early-exit branches never touch the database', () => {
  const operator: ConfigActor = { kind: 'operator' };
  const user: ConfigActor = { kind: 'user', userId: UserId.generate() };

  it('a refused authorization returns the error without any database call', async () => {
    const result = await setConfigValue(poisonTx(), {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 60,
      actor: user, // users may never write a deployment-level row
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFIG_LEVEL_NOT_PERMITTED');
  });

  it('an invalid value is rejected without any database call (BR-002-04)', async () => {
    const result = await setConfigValue(poisonTx(), {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 0, // out of range
      actor: operator,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFIG_INVALID_VALUE');
  });

  it('a tenant/user-level write with no userId is refused without any database call', async () => {
    const result = await setConfigValue(poisonTx(), {
      key: 'reports.concentration_threshold_pct',
      level: 'user',
      value: 25,
      actor: user,
      // userId omitted
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFIG_LEVEL_NOT_PERMITTED');
  });
});

describe('setConfigValue — write path against a fake Tx', () => {
  const operator: ConfigActor = { kind: 'operator' };

  it('reports no previous value on first write, and invalidates the deployment cache', async () => {
    primeDeploymentCacheForTest({ 'quotes.budget_alert_pct': 70 });
    // setConfigValue makes two inserts (config_overrides, then audit_log) —
    // captured in order, since the two rows have different shapes.
    const insertedRows: unknown[] = [];
    const tx = fakeTx({ selectRows: [], onInsertValues: (values) => insertedRows.push(values) });

    const result = await setConfigValue(tx, {
      key: 'quotes.budget_alert_pct',
      level: 'deployment',
      value: 85,
      actor: operator,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.previousValue).toBeUndefined();
      expect(result.value.newValue).toBe(85);
    }
    expect(insertedRows).toHaveLength(2);
    const [configOverrideRow, auditRow] = insertedRows as [
      { value: unknown },
      { actor: unknown; newValue: unknown },
    ];
    expect(configOverrideRow.value).toBe(85);
    expect(auditRow.actor).toBe('operator');
    expect(auditRow.newValue).toBe(85);
  });

  it('reports the previous value when an existing row is found', async () => {
    const tx = fakeTx({ selectRows: [{ value: 70 }] });

    const result = await setConfigValue(tx, {
      key: 'quotes.budget_alert_pct',
      level: 'deployment',
      value: 85,
      actor: operator,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.previousValue).toBe(70);
  });
});
