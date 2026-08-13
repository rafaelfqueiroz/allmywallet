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
  it('lists all 18 registry keys, each resolved to its own default, with description and levels attached', async () => {
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
});
