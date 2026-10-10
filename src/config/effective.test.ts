import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { fakeTx } from '@/config/test-support/fake-tx';
import { CONFIG_KEYS, REGISTRY } from '@/config/registry';
import { invalidateDeploymentCache } from '@/config/resolve';
import { getEffectiveConfig } from './effective';

/**
 * BR-002-09/BR-002-08. The scenarios that actually need real rows in real
 * tables — an operator override showing source "deployment", a runtime
 * degradation showing source "runtime" with its reason, no secret leaking
 * in — are tests/integration/config-effective.test.ts. `fakeTx` here can't
 * distinguish which table a SELECT targets, so it can only stand in for the
 * "nothing is set anywhere" case; that is still worth asserting on its own,
 * since it is what proves BR-002-01 ("every key resolves with its
 * documented default, no code change") holds through this view specifically,
 * not just through `resolveConfig` directly.
 */
describe('getEffectiveConfig — against a fake Tx with nothing set', () => {
  it('lists all registry keys, each resolved to its own default, with description and levels attached', async () => {
    invalidateDeploymentCache();
    const tx = fakeTx({ selectRows: [] });

    const effective = await getEffectiveConfig(tx);

    expect(effective).toHaveLength(CONFIG_KEYS.length);
    for (const entry of effective) {
      expect(entry.source).toBe('default');
      expect(entry.value).toEqual(REGISTRY[entry.key].default);
      expect(entry.description).toBe(REGISTRY[entry.key].description);
      expect(entry.levels).toEqual(REGISTRY[entry.key].levels);
      expect(entry.reason).toBeUndefined();
    }
  });

  it('also resolves for a specific userId without throwing, still all defaults with nothing stored', async () => {
    invalidateDeploymentCache();
    const tx = fakeTx({ selectRows: [] });

    const effective = await getEffectiveConfig(tx, { userId: UserId.generate() });

    expect(effective).toHaveLength(CONFIG_KEYS.length);
    expect(effective.every((entry) => entry.source === 'default')).toBe(true);
  });

  it('resolves only the keys asked for, in that order, with no reads for the rest', async () => {
    invalidateDeploymentCache();
    const base = fakeTx({ selectRows: [] });
    let selects = 0;
    const tx = {
      ...base,
      select: (...args: unknown[]) => (selects++, base.select(...(args as []))),
    };
    const keys = ['wallets.drift_tolerance_pp', 'import.staleness_days'] as const;

    const effective = await getEffectiveConfig(tx as typeof base, {
      userId: UserId.generate(),
      keys,
    });

    expect(effective.map((entry) => entry.key)).toEqual(keys);
    // One read to prime the deployment cache, then at most `runtime_state`
    // and `config_overrides` per key asked for — not per registry key.
    expect(selects).toBeGreaterThan(0);
    expect(selects).toBeLessThanOrEqual(1 + 2 * keys.length);
  });
});
