import { describe, expect, it } from 'vitest';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { createWallet } from '@/core/wallets/create-wallet';
import { allocateToWallet, computeUnassigned } from '@/core/wallets/allocate';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

const USER = UserId.generate();
const ITSA4 = AssetId.generate();

async function walletFor(deps: ReturnType<typeof buildFakeDeps>, name: string) {
  const result = await createWallet(deps, USER, { name });
  if (!result.ok) throw new Error('setup failed');
  return result.value;
}

describe('SPEC-010 BR-010-03/04/05/06 — allocateToWallet', () => {
  it('AC — assigning an asset takes the full held quantity in one click with no quantity typed', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('9.5'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const result = await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('100');
    // BR-010-22: cost basis at allocation is a snapshot of quantity × average cost.
    expect(result.value.costBasisAtAllocation?.toString()).toBe('950');
  });

  /**
   * SPEC-010 AC-10/BR-010-13 — resolving a "Needs attention" item.
   *
   * The two are genuinely different questions asked of the same table, and
   * conflating them destroys allocation:
   *
   *  - *absolute* answers "this wallet now holds N", which is what makes
   *    correcting an earlier 60/40 split into 70/30 a single action.
   *  - *add* answers "put these N unclaimed shares into this wallet", which
   *    is the only thing the pending queue ever asks.
   *
   * `pending.ts` pre-fills the form with the **unassigned remainder**, so
   * reading that number as an absolute target silently discards whatever the
   * chosen wallet already held. `ambiguous_split` items are by definition
   * assets that are already in at least one wallet, so the queue's primary
   * flow was the one that lost data.
   */
  it('AC-10 — resolving a pending item adds to what the wallet already holds', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');

    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('20'),
    });

    // The queue offers the 20 nobody has claimed; the user files them into
    // Aposentadoria, which already holds 60.
    const result = await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      mode: 'add',
      quantity: Quantity.fromString('20'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('80');

    // And the 40 that used to vanish are still where the user put them.
    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned).toHaveLength(0);
  });

  it('AC-10 — adding beyond the held quantity is still refused', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });

    const result = await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      mode: 'add',
      quantity: Quantity.fromString('50'),
    });

    expect(result.ok).toBe(false);
  });

  it('AC — a position can be split deliberately across two wallets by explicit action', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    const trading = await walletFor(deps, 'Trading');

    const first = await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });
    const second = await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('40'),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.quantity.toString()).toBe('60');
    expect(second.value.quantity.toString()).toBe('40');

    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned).toHaveLength(0);
  });

  it('AC — allocating more than the held quantity is refused at write time', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });

    const trading = await walletFor(deps, 'Trading');
    const result = await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('41'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ALLOCATION_EXCEEDS_HOLDINGS');
  });

  it('the default (one-click) quantity is the remaining unassigned amount, not literally everything', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const retirement = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: retirement.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });

    const trading = await walletFor(deps, 'Trading');
    const result = await allocateToWallet(deps, USER, { walletId: trading.id, assetId: ITSA4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quantity.toString()).toBe('40');
  });

  it('refuses a zero-quantity allocation', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    const second = await walletFor(deps, 'Trading');
    // Nothing is left unassigned, so the default (omitted quantity) resolves to zero.
    const result = await allocateToWallet(deps, USER, { walletId: second.id, assetId: ITSA4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ALLOCATION_QUANTITY');
  });

  it('reports WALLET_NOT_FOUND for a wallet belonging to another tenant', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');

    const other = UserId.generate();
    const result = await allocateToWallet(deps, other, { walletId: wallet.id, assetId: ITSA4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('re-assigning an existing wallet allocation keeps its original allocatedAt', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    const first = await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('50'),
    });
    if (!first.ok) throw new Error('setup failed');

    deps.clock.advanceMinutes(60);
    const second = await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('70'),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.allocatedAt).toEqual(first.value.allocatedAt);
    expect(second.value.quantity.toString()).toBe('70');
  });
});

describe('SPEC-010 BR-010-06/DL-010-07 — computeUnassigned', () => {
  it('AC — Unassigned is visible and its quantities are correct', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('100'), Money.fromString('10'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, {
      walletId: wallet.id,
      assetId: ITSA4,
      quantity: Quantity.fromString('60'),
    });

    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.assetId).toBe(ITSA4);
    expect(unassigned[0]?.quantity.toString()).toBe('40');
  });

  it('an asset never allocated is entirely Unassigned', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('30'), Money.fromString('5'));

    const unassigned = await computeUnassigned(deps, USER);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.quantity.toString()).toBe('30');
  });

  it('a fully allocated asset does not appear in Unassigned', async () => {
    const deps = buildFakeDeps();
    deps.positionQuery.set(ITSA4, Quantity.fromString('30'), Money.fromString('5'));
    const wallet = await walletFor(deps, 'Aposentadoria');
    await allocateToWallet(deps, USER, { walletId: wallet.id, assetId: ITSA4 });

    expect(await computeUnassigned(deps, USER)).toHaveLength(0);
  });
});
