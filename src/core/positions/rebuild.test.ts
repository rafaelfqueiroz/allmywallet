import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@/core/shared/clock';
import type { Clock } from '@/core/shared/clock';
import type { Transaction } from '@/core/ledger/transaction';
import { createTransaction } from '@/core/ledger/create-transaction';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import {
  FakePositionRepository,
  FakeTransactionRepository,
} from '@/core/ledger/test-support/fake-repositories';
import {
  TEST_USER_ID,
  aTransaction,
  assetIdFor,
  institutionIdFor,
  resetTransactionSequence,
} from '@/core/ledger/test-support/transaction-builder';
import { serializePosition } from '@/core/positions/position-state';
import { rebuildPositions } from '@/core/positions/rebuild';
import { positionKeyString, type PositionSnapshot } from '@/core/positions/replay';

/**
 * TS-08 / DM-4 / DL-007-06 — **rebuild equals incremental**, asserted as a
 * property over a generated history.
 *
 * This is the single highest-value test in the engine. The incremental path is
 * where subtle ordering bugs live, and they are invisible until a user
 * reconciles against a broker statement. The two paths are genuinely
 * different mechanisms and not two calls to the same function:
 *
 *   - **incremental** — every transaction goes through the real
 *     `createTransaction` use case in *arrival* order, each write triggering
 *     `recalculatePositionFrom`, exactly as production does;
 *   - **rebuild** — the finished ledger is replayed once from scratch.
 *
 * Arrival order is deliberately not chronological: the generator backdates
 * rows, which is what BR-006-18 promises to handle and what an append-only
 * incremental implementation would get wrong.
 */

/**
 * A seeded PRNG (mulberry32). `Math.random()` would make a failure
 * unreproducible, which for a property test is the difference between a bug
 * report and a shrug.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSETS = ['PETR4', 'VALE3', 'HGLG11', 'BOVA11'] as const;
const INSTITUTIONS: readonly (string | null)[] = ['Clear', 'Rico', null];

function isoDate(dayOffset: number): string {
  return new Date(Date.UTC(2026, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Builds a ledger that is valid by construction — never selling more than is
 * held — by walking each `(asset, institution)` position forward on strictly
 * increasing dates and tracking its quantity as it goes.
 *
 * Dates are strictly increasing *per position*, so the canonical replay order
 * is unambiguous and this test is about accumulation rather than about
 * same-day tie-breaks (those are pinned separately in `ordering.test.ts`).
 */
function generateHistory(seed: number, length: number): Transaction[] {
  const random = seededRandom(seed);
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error('generator: empty choice');
    return value;
  };

  const held = new Map<string, number>();
  const nextDay = new Map<string, number>();
  const rows: Transaction[] = [];

  for (let i = 0; i < length; i += 1) {
    const asset = pick(ASSETS);
    const institution = pick(INSTITUTIONS);
    const key = `${asset}|${institution ?? ''}`;
    const quantity = held.get(key) ?? 0;
    const day = (nextDay.get(key) ?? 0) + 1 + Math.floor(random() * 3);
    nextDay.set(key, day);

    const base = aTransaction().of(asset).at(institution).on(isoDate(day));
    const roll = random();

    if (quantity >= 1 && roll < 0.25) {
      // Whole shares only, and never more than the floor of what is held — a
      // grupamento can leave a fractional balance behind.
      const sold = 1 + Math.floor(random() * Math.floor(quantity));
      held.set(key, quantity - sold);
      rows.push(base.sell().quantity(String(sold)).price(price(random)).fees('0.97').build());
    } else if (quantity > 0 && roll < 0.35) {
      // A share-base event: ratio 2 or 0,5. Quantity scales, cost does not.
      const ratio = random() < 0.5 ? 2 : 0.5;
      held.set(key, quantity * ratio);
      rows.push((ratio === 2 ? base.split() : base.grupamento()).ratio(String(ratio)).build());
    } else if (quantity > 0 && roll < 0.45) {
      const bonus = 1 + Math.floor(random() * 5);
      held.set(key, quantity + bonus);
      rows.push(
        base
          .bonificacao()
          .quantity(String(bonus))
          .price(random() < 0.5 ? '0' : '3.33')
          .build(),
      );
    } else if (roll < 0.55) {
      // Proventos: no position effect, but they must survive the round trip.
      rows.push(
        base
          .dividend()
          .quantity(String(Math.max(quantity, 1)))
          .price('0.37')
          .build(),
      );
    } else {
      const bought = 1 + Math.floor(random() * 50);
      held.set(key, quantity + bought);
      rows.push(base.buy().quantity(String(bought)).price(price(random)).fees('4.13').build());
    }
  }

  return rows;
}

/** Prices with awkward decimals, so every average is a repeating one. */
function price(random: () => number): string {
  const candidates = ['3.33', '10.07', '7.77', '12.85', '0.33333333', '21.11', '99.99'];
  const chosen = candidates[Math.floor(random() * candidates.length)];
  return chosen ?? '10.07';
}

/** Fisher–Yates against the same seeded PRNG — arrival order, not trade order. */
function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

function deps(clock: Clock): LedgerDependencies & {
  transactions: FakeTransactionRepository;
  positions: FakePositionRepository;
} {
  return {
    transactions: new FakeTransactionRepository(),
    positions: new FakePositionRepository(),
    clock,
  };
}

/**
 * Feeds rows through the real `createTransaction` use case in **arrival**
 * order, deferring any the ledger cannot support yet and retrying on a later
 * pass.
 *
 * The deferral is the honest part, and it is what the first run of this test
 * exposed. BR-006-15's guard is on the ledger *as it stands*, so a sell that
 * arrives before the buy it draws on is refused — correctly. A user entering
 * history out of order hits exactly this and enters the buy next. Modelling
 * that keeps arrival order genuinely scrambled (which is the point: `created_at`
 * then disagrees with `trade_date`, and an append-only implementation breaks)
 * without pretending the write path accepts an impossible intermediate state.
 *
 * Returns how many rows were accepted, so the caller can assert none were
 * silently dropped. A pass that makes no progress means the generator built an
 * unenterable ledger — a bug in the fixture, and it fails loudly rather than
 * quietly comparing two empty position sets.
 */
async function enterInArrivalOrder(
  state: LedgerDependencies,
  arrival: readonly Transaction[],
): Promise<number> {
  let pending = [...arrival];
  let accepted = 0;

  while (pending.length > 0) {
    const deferred: Transaction[] = [];
    for (const row of pending) {
      const result = await createTransaction(state, TEST_USER_ID, {
        assetId: row.assetId,
        institutionId: row.institutionId,
        type: row.type,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fees: row.fees,
        ratio: row.ratio,
      });
      if (result.ok) {
        accepted += 1;
      } else if (result.error.code === 'INSUFFICIENT_QUANTITY') {
        deferred.push(row);
      } else {
        throw new Error(`generator produced an invalid row: ${result.error.code}`);
      }
    }
    if (deferred.length === pending.length) {
      throw new Error(`generator produced an unenterable ledger: ${deferred.length} rows stuck`);
    }
    pending = deferred;
  }

  return accepted;
}

function fingerprint(snapshots: readonly PositionSnapshot[]) {
  return [...snapshots]
    .sort((a, b) => (positionKeyString(a) < positionKeyString(b) ? -1 : 1))
    .map((snapshot) => ({
      key: positionKeyString(snapshot),
      ...serializePosition(snapshot.state),
    }));
}

describe('TS-08 — rebuild equals incremental', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  // A clock well past every generated trade date, so BR-006-15's
  // future-date guard never fires on the fixture itself.
  const clock = new FakeClock('2030-01-01T12:00:00Z');

  it.each([1, 2, 7, 42, 1337, 20260315])(
    'agrees on a generated history (seed %i) fed in scrambled arrival order',
    async (seed) => {
      resetTransactionSequence();
      const chronological = generateHistory(seed, 120);
      const arrival = shuffle(chronological, seededRandom(seed + 1));

      // ---- incremental: the real write path, one transaction at a time ----
      const incremental = deps(clock);
      const accepted = await enterInArrivalOrder(incremental, arrival);
      expect(accepted).toBe(arrival.length);

      // ---- rebuild: one replay of the finished ledger ----
      const rebuilt = await rebuildPositions({
        transactions: incremental.transactions,
        positions: new FakePositionRepository(),
      });
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      const incrementalPositions = await incremental.positions.list();

      expect(fingerprint(incrementalPositions)).toEqual(fingerprint(rebuilt.value));
      // Guards against the degenerate pass where both sides are empty.
      expect(incrementalPositions.length).toBeGreaterThan(0);
    },
  );

  it('agrees after a backdated insertion between existing trades (TS-07, BR-006-18)', async () => {
    // The incremental cache is built from three trades, then a *fourth* is
    // inserted with a date between the first and the second. An implementation
    // that appended rather than replaying would keep the old average.
    const state = deps(clock);
    const rows = [
      aTransaction().buy().on('2026-01-05').quantity('100').price('20.00').fees('10.00').build(),
      aTransaction().buy().on('2026-03-15').quantity('100').price('12.85').fees('5.00').build(),
      aTransaction().sell().on('2026-05-25').quantity('50').price('25.00').fees('12.00').build(),
      // The backdated one: a split on 2026-02-10, entered last.
      aTransaction().split().on('2026-02-10').ratio('2').build(),
    ];

    for (const row of rows) {
      const result = await createTransaction(state, TEST_USER_ID, {
        assetId: row.assetId,
        institutionId: row.institutionId,
        type: row.type,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        fees: row.fees,
        ratio: row.ratio,
      });
      expect(result.ok).toBe(true);
    }

    const rebuilt = await rebuildPositions({
      transactions: state.transactions,
      positions: new FakePositionRepository(),
    });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    expect(fingerprint(await state.positions.list())).toEqual(fingerprint(rebuilt.value));

    // And the figures are the hand-computed ones from the TS-06 sequence:
    //   buy 100 @ 20,00 +10,00 fees → 2.010,00 over 100
    //   split ×2                    → 2.010,00 over 200
    //   buy 100 @ 12,85 +5,00 fees  → 3.300,00 over 300, average 11,00
    //   sell 50 @ 25,00, fees 12,00 → realized (25,00 − 11,00) × 50 − 12,00
    //                                        = 700,00 − 12,00 = 688,00
    //                                 quantity 250
    //                                 total 3.300,00 − 11,00 × 50 = 2.750,00
    const [position] = rebuilt.value;
    expect(position?.state.quantity.toString()).toBe('250');
    expect(position?.state.averageCost.toString()).toBe('11');
    expect(position?.state.totalCost.toString()).toBe('2750');
    expect(position?.state.realizedGain.toString()).toBe('688');
  });
});

describe('rebuildPositions', () => {
  beforeEach(() => {
    resetTransactionSequence();
  });

  it('replaces the whole cache, dropping positions the ledger no longer supports', async () => {
    const transactions = new FakeTransactionRepository([
      aTransaction().buy().of('PETR4').quantity('100').price('10.00').build(),
    ]);
    const positions = new FakePositionRepository();
    // A stale row for an asset with no transactions behind it — exactly what a
    // rebuild exists to clear.
    await positions.upsertMany([
      {
        assetId: assetIdFor('STALE3'),
        institutionId: institutionIdFor('Clear'),
        state: (await rebuildOne()).state,
      },
    ]);

    const result = await rebuildPositions({ transactions, positions });
    expect(result.ok).toBe(true);

    const stored = await positions.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.assetId).toBe(assetIdFor('PETR4'));
    expect(positions.replaceAllCount).toBe(1);
  });

  it('writes nothing when the ledger cannot be replayed', async () => {
    // A half-overwritten cache would be neither the old figures nor the new
    // ones, with nothing to say so.
    const transactions = new FakeTransactionRepository([
      aTransaction().buy().on('2026-01-05').quantity('10').price('10.00').build(),
      aTransaction().sell().on('2026-02-05').quantity('50').price('12.00').build(),
    ]);
    const positions = new FakePositionRepository();

    const result = await rebuildPositions({ transactions, positions });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
    expect(positions.replaceAllCount).toBe(0);
  });

  it('rebuilds an empty ledger to an empty cache', async () => {
    const positions = new FakePositionRepository();
    const result = await rebuildPositions({
      transactions: new FakeTransactionRepository([]),
      positions,
    });
    expect(result.ok && result.value).toEqual([]);
    expect(await positions.list()).toEqual([]);
  });
});

/** A throwaway snapshot, only used to seed a stale cache row. */
async function rebuildOne(): Promise<PositionSnapshot> {
  const transactions = new FakeTransactionRepository([
    aTransaction().buy().of('STALE3').at('Clear').quantity('5').price('1.00').build(),
  ]);
  const result = await rebuildPositions({
    transactions,
    positions: new FakePositionRepository(),
  });
  if (!result.ok) throw new Error('fixture');
  const [only] = result.value;
  if (only === undefined) throw new Error('fixture');
  return only;
}
