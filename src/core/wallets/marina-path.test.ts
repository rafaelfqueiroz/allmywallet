import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, TransactionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { Transaction } from '@/core/ledger/transaction';
import { allocateToWallet, computeUnassigned } from '@/core/wallets/allocate';
import { applyLedgerEffects } from '@/core/wallets/apply-ledger-effects';
import { createWallet } from '@/core/wallets/create-wallet';
import { listPendingAllocations } from '@/core/wallets/pending';
import { buildFakeDeps } from '@/core/wallets/test-support/build-deps';

/**
 * SPEC-010 AC-010-19 — **Marina's acceptance path**: "six dividend payers
 * assigned in six clicks; next import auto-allocates five of them; the sixth
 * (deliberately split) waits in Needs attention".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE RULES IT COMPOSES
 *
 * Every rule below is already unit-tested on its own: BR-010-03's one-click
 * assignment, BR-010-10's auto-increment, BR-010-11's refusal to guess,
 * BR-010-12's queue. Each passes in isolation and each is a different file.
 *
 * The acceptance criterion is not any of them — it is the *claim that they
 * compose into a usable afternoon*. Five assets behaving one way and a sixth
 * behaving differently, in the same import, is a statement about the
 * interaction, and nothing asserted it. The failure it guards is the plausible
 * one: a change that makes auto-increment slightly more eager, so the split
 * asset quietly gets allocated too, and every existing test still passes
 * because none of them holds five and one at the same time.
 *
 * Written at the domain level rather than as an E2E on purpose. What is being
 * verified is the allocation behaviour across a batch, and `tests/e2e`
 * already covers that the screens which drive it exist and post correctly
 * (`transactions.spec.ts`, `import.spec.ts`). "Six clicks" is asserted as six
 * calls with no quantity argument — which is what one click emits.
 * ---------------------------------------------------------------------------
 */
describe('SPEC-010 AC-010-19 — Marina assigns six payers and imports again', () => {
  const USER = UserId.generate();
  /** ITSA4, BBSE3, TAEE11, EGIE3, VIVT3 and — the awkward one — BBAS3. */
  const PAYERS = ['ITSA4', 'BBSE3', 'TAEE11', 'EGIE3', 'VIVT3', 'BBAS3'] as const;

  function buy(assetId: AssetId, quantity: string): Transaction {
    return {
      id: TransactionId.generate(),
      userId: USER,
      assetId,
      institutionId: null,
      type: 'buy',
      status: 'active',
      tradeDate: BusinessDate.of('2026-04-01'),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString('10'),
      fees: Money.zero(),
      ratio: null,
      totalValue: Money.fromString('100'),
      naturalKey: `marina-${assetId}-${quantity}`,
      occurrence: 1,
      importBatchId: null,
      isManual: false,
      isUserModified: false,
      createdAt: new Date('2026-04-01T12:00:00Z'),
      updatedAt: new Date('2026-04-01T12:00:00Z'),
    };
  }

  async function marinasAfternoon() {
    const deps = buildFakeDeps();
    const assets = new Map(PAYERS.map((code) => [code, AssetId.generate()]));

    const dividends = await createWallet(deps, USER, { name: 'Dividendos' });
    const trading = await createWallet(deps, USER, { name: 'Trading' });
    if (!dividends.ok || !trading.ok) throw new Error('setup failed');

    // She holds 100 of each after her first import.
    for (const assetId of assets.values()) {
      deps.positionQuery.set(assetId, Quantity.fromString('100'), Money.fromString('10'));
    }

    /**
     * Six clicks. BR-010-03: no quantity is typed — omitting it *is* the
     * one-click gesture, and `allocateToWallet` defaults to the whole
     * unassigned remainder.
     */
    for (const assetId of assets.values()) {
      const result = await allocateToWallet(deps, USER, {
        walletId: dividends.value.id,
        assetId,
      });
      expect(result.ok).toBe(true);
    }

    return { deps, assets, dividends: dividends.value, trading: trading.value };
  }

  it('six clicks assign all six, with nothing left unassigned', async () => {
    const { deps, assets } = await marinasAfternoon();

    expect(await computeUnassigned(deps, USER)).toEqual([]);
    for (const assetId of assets.values()) {
      const rows = await deps.allocations.listForAsset(assetId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.quantity.toString()).toBe('100');
    }
  });

  it('the next import auto-allocates five and leaves the split sixth pending', async () => {
    const { deps, assets, dividends, trading } = await marinasAfternoon();

    /**
     * The sixth is deliberately split — BR-010-04's explicit action, and the
     * one difference between BBAS3 and its five siblings. Two `absolute`
     * assignments: 60 stays in Dividendos, 40 moves to Trading. The order
     * matters — the whole 100 is claimed, so Dividendos has to give up the 40
     * before Trading can take it, which is BR-010-05 refusing to be
     * circumvented rather than an inconvenience.
     */
    const bbas3 = assets.get('BBAS3')!;
    const reduced = await allocateToWallet(deps, USER, {
      walletId: dividends.id,
      assetId: bbas3,
      quantity: Quantity.fromString('60'),
    });
    expect(reduced.ok).toBe(true);
    const moved = await allocateToWallet(deps, USER, {
      walletId: trading.id,
      assetId: bbas3,
      quantity: Quantity.fromString('40'),
    });
    expect(moved.ok).toBe(true);
    expect(await deps.allocations.listForAsset(bbas3)).toHaveLength(2);

    // The next import: 50 more of every payer.
    for (const assetId of assets.values()) {
      deps.positionQuery.set(assetId, Quantity.fromString('150'), Money.fromString('10'));
    }
    const effects = await applyLedgerEffects(
      deps,
      USER,
      [...assets.values()].map((assetId) => buy(assetId, '50')),
    );
    expect(effects.ok).toBe(true);

    // BR-010-10: the five single-wallet payers each grew by the full purchase,
    // with no user action.
    for (const code of PAYERS.filter((each) => each !== 'BBAS3')) {
      const rows = await deps.allocations.listForAsset(assets.get(code)!);
      expect(rows, code).toHaveLength(1);
      expect(rows[0]?.quantity.toString(), code).toBe('150');
    }

    // BR-010-11: the split one was not distributed, not proportioned, not
    // guessed at. Its 50 sit unallocated.
    const bbasRows = await deps.allocations.listForAsset(bbas3);
    expect(bbasRows).toHaveLength(2);
    expect(
      bbasRows.reduce((total, row) => total.plus(row.quantity), Quantity.zero()).toString(),
    ).toBe('100');

    // BR-010-12: and it is the *only* thing waiting for her.
    const pending = await listPendingAllocations(deps, USER);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.assetId).toBe(bbas3);
    expect(pending[0]?.reason).toBe('ambiguous_split');
    expect(pending[0]?.unassignedQuantity.toString()).toBe('50');
  });
});
