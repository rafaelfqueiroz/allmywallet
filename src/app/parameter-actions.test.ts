import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/core/shared/result';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/session', () => ({ requireUserId: vi.fn(async () => 'user-1') }));
vi.mock('@/db/tenant', () => ({
  withTenantRollbackOn: vi.fn(async (_userId: string, work: (tx: unknown) => Promise<unknown>) =>
    work({}),
  ),
}));
vi.mock('@/config/resolve', () => ({ setConfigValue: vi.fn() }));
vi.mock('@/config/effective', () => ({ getEffectiveConfig: vi.fn() }));

import { revalidatePath } from 'next/cache';
import { getEffectiveConfig } from '@/config/effective';
import { setConfigValue } from '@/config/resolve';
import { withTenantRollbackOn } from '@/db/tenant';
import { saveParameters } from '@/app/parameter-actions';

/**
 * SPEC-022 BR-022-37 — a surface's parameters are one form with one Salvar,
 * so the action takes every key on the surface at once. SPEC-002 BR-002-03/04
 * still hold per key; BR-002-07's audit must not record a "change" from a
 * value to itself.
 */
const EFFECTIVE = [
  { key: 'reports.concentration_threshold_pct', value: 25 },
  { key: 'reports.benchmarks', value: ['IPCA', 'CDI'] },
  { key: 'reports.twr_xirr_divergence_points', value: 500 },
  { key: 'reports.default_grouping', value: 'asset_class' },
  { key: 'reports.default_grouping_wallet_scope', value: 'asset' },
  { key: 'import.reminder_enabled', value: true },
  { key: 'ui.theme', value: 'system' },
  { key: 'ui.hide_values', value: false },
];

/** The Preferências form as loaded, with `changes` applied. */
function preferences(changes: Record<string, string | readonly string[] | null> = {}): FormData {
  const fields: Record<string, string | readonly string[] | null> = {
    'reports.concentration_threshold_pct': '25',
    // Posted in option order, not the stored order.
    'reports.benchmarks': ['CDI', 'IPCA'],
    'reports.twr_xirr_divergence_points': '500',
    'reports.default_grouping': 'asset_class',
    'reports.default_grouping_wallet_scope': 'asset',
    'import.reminder_enabled': 'on',
    'ui.theme': 'system',
    'ui.hide_values': null,
    ...changes,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue;
    for (const one of typeof value === 'string' ? [value] : value) data.append(key, one);
  }
  return data;
}

describe('saveParameters — one form per surface (BR-022-37)', () => {
  beforeEach(() => {
    vi.mocked(setConfigValue).mockReset();
    vi.mocked(setConfigValue).mockResolvedValue(ok(undefined) as never);
    vi.mocked(revalidatePath).mockReset();
    vi.mocked(getEffectiveConfig).mockResolvedValue(EFFECTIVE as never);
  });

  it('writes only the key whose value changed, at user level', async () => {
    const state = await saveParameters(
      'preferences',
      preferences({ 'reports.concentration_threshold_pct': '42' }),
    );

    expect(state).toEqual({ status: 'saved' });
    expect(setConfigValue).toHaveBeenCalledTimes(1);
    expect(setConfigValue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        key: 'reports.concentration_threshold_pct',
        level: 'user',
        value: 42,
        userId: 'user-1',
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('writes nothing when nothing changed — an array compares as a set', async () => {
    const state = await saveParameters('preferences', preferences());
    expect(state).toEqual({ status: 'saved' });
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it('reads an unticked checkbox as false', async () => {
    await saveParameters('preferences', preferences({ 'import.reminder_enabled': null }));
    expect(setConfigValue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ key: 'import.reminder_enabled', value: false }),
    );
  });

  it('refuses every write when one value is out of range, naming each refused key', async () => {
    const state = await saveParameters(
      'preferences',
      preferences({
        'reports.concentration_threshold_pct': '420',
        'reports.benchmarks': [],
        'ui.theme': 'dark',
      }),
    );

    expect(state).toEqual({
      status: 'error',
      invalid: ['reports.concentration_threshold_pct', 'reports.benchmarks'],
    });
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rolls back when a write is refused late, and names the key', async () => {
    vi.mocked(setConfigValue).mockResolvedValue(err({ code: 'INVALID_VALUE' }) as never);

    const state = await saveParameters('preferences', preferences({ 'ui.theme': 'dark' }));

    expect(state).toEqual({ status: 'error', invalid: ['ui.theme'] });
    const shouldRollback = vi.mocked(withTenantRollbackOn).mock.calls.at(-1)![2];
    expect(shouldRollback(state as never)).toBe(true);
    expect(shouldRollback({ status: 'saved' } as never)).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('reads only the posted surface’s keys, and refuses an unknown surface', async () => {
    vi.mocked(getEffectiveConfig).mockResolvedValue([
      { key: 'wallets.drift_tolerance_pp', value: 5 },
    ] as never);
    const data = new FormData();
    data.set('wallets.drift_tolerance_pp', '2.5');
    // A key from another surface is not this form's to write.
    data.set('ui.theme', 'dark');

    await saveParameters('settings.wallets', data);
    expect(setConfigValue).toHaveBeenCalledTimes(1);
    expect(setConfigValue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ key: 'wallets.drift_tolerance_pp', value: 2.5 }),
    );

    expect(await saveParameters('deployment', data)).toEqual({ status: 'error' });
  });
});
