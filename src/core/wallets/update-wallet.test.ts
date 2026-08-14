import { describe, expect, it } from 'vitest';
import { UserId, WalletId } from '@/core/shared/ids';
import { createWallet } from '@/core/wallets/create-wallet';
import { updateWallet } from '@/core/wallets/update-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const OTHER_USER = UserId.generate();

describe('SPEC-010 BR-010-01 — updateWallet', () => {
  it('renames, describes and recolours a wallet', async () => {
    const deps = buildFakeDeps();
    const created = await createWallet(deps, USER, { name: 'Trading' });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateWallet(deps, USER, {
      walletId: created.value.id,
      name: 'Aposentadoria',
      description: 'Renomeada',
      color: '#ef4444',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Aposentadoria');
    expect(result.value.description).toBe('Renomeada');
    expect(result.value.color).toBe('#ef4444');
  });

  it('leaves a field untouched when the input omits it', async () => {
    const deps = buildFakeDeps();
    const created = await createWallet(deps, USER, { name: 'Trading', goal: 'Curto prazo' });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateWallet(deps, USER, {
      walletId: created.value.id,
      name: 'Renomeada',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.goal).toBe('Curto prazo');
  });

  it('refuses a blank name', async () => {
    const deps = buildFakeDeps();
    const created = await createWallet(deps, USER, { name: 'Trading' });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateWallet(deps, USER, { walletId: created.value.id, name: '  ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_NAME');
  });

  it('refuses to update another tenant’s wallet', async () => {
    const deps = buildFakeDeps();
    const created = await createWallet(deps, USER, { name: 'Trading' });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateWallet(deps, OTHER_USER, {
      walletId: created.value.id,
      name: 'Hijacked',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('reports not found for an unknown wallet', async () => {
    const deps = buildFakeDeps();
    const result = await updateWallet(deps, USER, { walletId: WalletId.generate(), name: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
  });
});
