import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserId } from '@/core/shared/ids';

const tenantMocks = vi.hoisted(() => ({
  withTenant: vi.fn(),
  withTenantRollbackOn: vi.fn(),
}));

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/db/tenant', () => tenantMocks);

import { withTransactionWriteDeps } from './composition';

describe('withTransactionWriteDeps', () => {
  const userId = UserId.of('01920000-0000-7000-8000-000000000003');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes returned ActionState errors through the tenant rollback predicate', async () => {
    const refusal = {
      status: 'error',
      code: 'ALLOCATION_EXCEEDS_HOLDINGS',
      context: { held: '10', requested: '11' },
    } as const;
    tenantMocks.withTenantRollbackOn.mockResolvedValue(refusal);

    const result = await withTransactionWriteDeps(userId, async () => refusal);

    expect(result).toBe(refusal);
    expect(tenantMocks.withTenantRollbackOn).toHaveBeenCalledTimes(1);
    const shouldRollback = tenantMocks.withTenantRollbackOn.mock.calls[0]?.[2] as
      ((value: unknown) => boolean) | undefined;
    expect(shouldRollback?.(refusal)).toBe(true);
    expect(shouldRollback?.({ status: 'idle' })).toBe(false);
    expect(shouldRollback?.({ status: 'assigned', assigned: 1, skipped: 0 })).toBe(false);
  });
});
