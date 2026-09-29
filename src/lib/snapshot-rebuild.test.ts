import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';

vi.mock('@/lib/queue', () => ({ enqueue: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { requestSnapshotRebuild } from '@/lib/snapshot-rebuild';

const USER = UserId.of('01920000-0000-7000-8000-000000000003');

describe('SPEC-009 BR-009-18 — requestSnapshotRebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueue).mockResolvedValue(undefined);
  });

  it('enqueues one valuation.snapshot from the given date, with ids and dates only', async () => {
    await requestSnapshotRebuild(USER, BusinessDate.of('2020-01-13'));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('valuation.snapshot', {
      userId: USER,
      from: '2020-01-13',
    });
  });

  it('enqueues nothing when the write recalculated nothing', async () => {
    await requestSnapshotRebuild(USER, null);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed enqueue — the nightly sweep is the safety net', async () => {
    vi.mocked(enqueue).mockRejectedValue(new Error('pg-boss unreachable'));

    await expect(
      requestSnapshotRebuild(USER, BusinessDate.of('2020-01-13')),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, message] = vi.mocked(logger.error).mock.calls[0] ?? [];
    // BR-004-04: the tenant UUID and a date, nothing about the portfolio.
    expect(fields).toMatchObject({ userId: USER, from: '2020-01-13' });
    expect(message).toContain('BR-009-18');
  });
});
