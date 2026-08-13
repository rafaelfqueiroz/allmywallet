import { beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate, FakeClock } from '@/core/shared/clock';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import { guardReplayable, without } from '@/core/ledger/guard-replayable';
import { recalculatePositionFrom } from '@/core/ledger/recalculate-from';
import type { Transaction } from '@/core/ledger/transaction';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';

const CLOCK = new FakeClock('2026-06-30T12:00:00Z');

function deps(rows: readonly Transaction[]): LedgerDependencies & {
  transactions: FakeTransactionRepository;
  positions: FakePositionRepository;
} {
  return {
    transactions: new FakeTransactionRepository(rows),
    positions: new FakePositionRepository(),
    clock: CLOCK,
  };
}

describe('SPEC-006 BR-006-14 / DL-006-03 — recalculatePositionFrom', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  const scope = {
    assetId: assetIdFor('PETR4'),
    institutionId: null,
    fromDate: BusinessDate.of('2026-02-01'),
  };

  it('replays the whole position and writes it to the cache', async () => {
    // Recomputed from the beginning, not resumed from `fromDate`: a moving
    // average is path-dependent from the first acquisition, so there is
    // nothing cheaper to resume from.
    //   100 @ 10,00 + 100 @ 20,00 = 3.000,00 over 200 → average 15,00
    const state = deps([
      aTransaction().buy().on('2026-01-05').quantity('100').price('10.00').build(),
      aTransaction().buy().on('2026-03-05').quantity('100').price('20.00').build(),
    ]);

    const result = await recalculatePositionFrom(state, scope);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position?.state.averageCost.toString()).toBe('15');
    expect(await state.positions.list()).toHaveLength(1);
  });

  it('carries fromDate forward as the invalidation boundary for SPEC-009', async () => {
    // DL-006-03's "forward from the transaction date" is about *which derived
    // artefacts go stale*, not about how the position is computed. Nothing
    // consumes this yet; recording it now is what stops SPEC-009 needing a
    // second pass over every write path.
    const state = deps([aTransaction().buy().build()]);
    const result = await recalculatePositionFrom(state, scope);
    expect(result.ok && result.value.scope.fromDate).toBe('2026-02-01');
  });

  it('deletes the cached position when the ledger for it is empty', async () => {
    const state = deps([]);
    await state.positions.upsertMany([
      {
        assetId: assetIdFor('PETR4'),
        institutionId: null,
        state: {
          quantity: aTransaction().build().quantity,
          totalCost: aTransaction().build().unitPrice,
          averageCost: aTransaction().build().unitPrice,
          realizedGain: aTransaction().build().fees,
        },
      },
    ]);

    const result = await recalculatePositionFrom(state, scope);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.position).toBeNull();
    expect(await state.positions.list()).toEqual([]);
  });

  it('writes nothing when the position cannot be replayed', async () => {
    const state = deps([
      aTransaction().buy().on('2026-01-05').quantity('10').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('50').price('12.00').build(),
    ]);

    const result = await recalculatePositionFrom(state, scope);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(state.positions.upsertCount).toBe(0);
  });

  it('touches only the position it was asked about', async () => {
    const state = deps([
      aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build(),
      aTransaction().buy().of('VALE3').at('Rico').quantity('10').price('60.00').build(),
    ]);

    await recalculatePositionFrom(state, scope);

    const positions = await state.positions.list();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.assetId).toBe(assetIdFor('PETR4'));
  });

  it('scopes by institution, treating null as its own bucket', async () => {
    const state = deps([
      aTransaction().buy().of('PETR4').at(null).quantity('100').price('10.00').build(),
      aTransaction().buy().of('PETR4').at('Clear').quantity('500').price('99.00').build(),
    ]);

    const result = await recalculatePositionFrom(state, scope);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the null-institution rows, so 100 shares at 10,00 — not 600.
    expect(result.value.position?.state.quantity.toString()).toBe('100');
  });
});

describe('guardReplayable', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  const key = { assetId: assetIdFor('PETR4'), institutionId: institutionIdFor('Clear') };

  it('accepts a projection that replays', async () => {
    const state = deps([
      aTransaction().buy().of('PETR4').at('Clear').quantity('100').price('10.00').build(),
    ]);
    const result = await guardReplayable(state, key, (existing) => existing);
    expect(result.ok).toBe(true);
  });

  it('rejects a projection that does not, propagating the engine’s error', async () => {
    const rows = [
      aTransaction()
        .buy()
        .of('PETR4')
        .at('Clear')
        .on('2026-01-05')
        .quantity('100')
        .price('10.00')
        .build(),
      aTransaction()
        .sell()
        .of('PETR4')
        .at('Clear')
        .on('2026-02-05')
        .quantity('100')
        .price('12.00')
        .build(),
    ];
    const state = deps(rows);
    const buy = rows[0];
    if (!buy) return;

    const result = await guardReplayable(state, key, (existing) =>
      without(existing, new Set([buy.id])),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
  });
});

describe('without', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('removes exactly the named rows', () => {
    const rows = [aTransaction().build(), aTransaction().build(), aTransaction().build()];
    const [first, , third] = rows;
    if (!first || !third) return;

    const remaining = without(rows, new Set([first.id, third.id]));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(rows[1]?.id);
  });

  it('removes nothing when the set is empty', () => {
    const rows = [aTransaction().build()];
    expect(without(rows, new Set())).toHaveLength(1);
  });
});
