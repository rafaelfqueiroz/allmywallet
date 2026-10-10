import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/core/shared/result';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ signOut: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/session', () => ({ requireUserId: vi.fn(async () => 'user-1') }));
vi.mock('@/db/tenant', () => ({
  withTenant: vi.fn(async (_userId: string, work: (tx: unknown) => unknown) => work({})),
}));
vi.mock('@/config/resolve', () => ({ setConfigValue: vi.fn() }));

import { revalidatePath } from 'next/cache';
import { setConfigValue } from '@/config/resolve';
import { saveHideValuesAction } from '@/app/(settings)/account/actions';

function form(hidden: string | null): FormData {
  const data = new FormData();
  if (hidden !== null) data.set('hidden', hidden);
  return data;
}

describe('saveHideValuesAction (SPEC-022 BR-022-24/25)', () => {
  beforeEach(() => {
    vi.mocked(setConfigValue).mockReset();
    vi.mocked(revalidatePath).mockReset();
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('writes ui.hide_values = %s at user level and re-renders every layout', async (raw, value) => {
    vi.mocked(setConfigValue).mockResolvedValue(ok(undefined) as never);

    await saveHideValuesAction(form(raw));

    expect(setConfigValue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ key: 'ui.hide_values', level: 'user', value, userId: 'user-1' }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it.each([null, '', 'yes', 'TRUE'])('changes nothing for %j', async (raw) => {
    await saveHideValuesAction(form(raw));

    expect(setConfigValue).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('re-renders nothing when the write is refused', async () => {
    vi.mocked(setConfigValue).mockResolvedValue(err({ code: 'X' }) as never);

    await saveHideValuesAction(form('true'));

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
