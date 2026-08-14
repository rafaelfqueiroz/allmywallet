import { describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { createWallet } from '@/core/wallets/create-wallet';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();

describe('SPEC-010 BR-010-01/BR-010-02 — createWallet', () => {
  it('creates a wallet with a name, description, goal and colour', async () => {
    const deps = buildFakeDeps();
    const result = await createWallet(deps, USER, {
      name: 'Aposentadoria',
      description: 'Dividendos de longo prazo',
      goal: 'Renda passiva em 2045',
      color: '#22c55e',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Aposentadoria');
    expect(result.value.description).toBe('Dividendos de longo prazo');
    expect(result.value.goal).toBe('Renda passiva em 2045');
    expect(result.value.color).toBe('#22c55e');
    expect(result.value.userId).toBe(USER);

    expect(await deps.wallets.list()).toHaveLength(1);
  });

  it('creates a wallet with only a name — every other field is optional', async () => {
    const deps = buildFakeDeps();
    const result = await createWallet(deps, USER, { name: 'Trading' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBeNull();
    expect(result.value.goal).toBeNull();
    expect(result.value.color).toBeNull();
  });

  it('refuses a blank name', async () => {
    const deps = buildFakeDeps();
    const result = await createWallet(deps, USER, { name: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_NAME');
    expect(await deps.wallets.list()).toHaveLength(0);
  });

  it('trims whitespace from the name and blank optional fields become null', async () => {
    const deps = buildFakeDeps();
    const result = await createWallet(deps, USER, {
      name: '  Aposentadoria  ',
      description: '   ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Aposentadoria');
    expect(result.value.description).toBeNull();
  });
});
