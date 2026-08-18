import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { ASSET_CLASSES } from '@/db/schema/assets';
import { replayPositions } from '@/core/positions/replay';
import {
  REFERENCE_ASSET_CLASS_TO_SCHEMA,
  REFERENCE_ASSET_COUNT,
  REFERENCE_AS_OF_DATE,
  REFERENCE_START_DATE,
  REFERENCE_TRANSACTION_COUNT,
  centsToDecimalString,
  generateReferenceAssets,
  generateReferenceTransactions,
  generateReferenceWorkload,
  referenceTransactionRows,
} from '@/db/reference-workload';

/**
 * SPEC-016 BR-016-01/TS-23: "100 assets, 10,000 transactions, 5 years of
 * history... generated deterministically from a fixed seed, so performance
 * numbers are comparable across runs."
 */
describe('generateReferenceAssets', () => {
  it('generates exactly 100 assets by default (BR-016-01)', () => {
    expect(generateReferenceAssets()).toHaveLength(REFERENCE_ASSET_COUNT);
  });

  it('every asset has a unique ticker', () => {
    const tickers = generateReferenceAssets().map((a) => a.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it('cycles through every asset class evenly — BR-016-03 needs every grouping exercised', () => {
    const assets = generateReferenceAssets();
    const classes = new Set(assets.map((a) => a.assetClass));
    expect(classes).toEqual(
      new Set(['acao', 'fii', 'bdr', 'etf', 'tesouro_direto', 'cdb', 'lci', 'lca']),
    );
  });

  it('is deterministic — same call, same output', () => {
    expect(generateReferenceAssets()).toEqual(generateReferenceAssets());
  });
});

describe('generateReferenceTransactions', () => {
  it('generates exactly 10,000 transactions by default (BR-016-01)', () => {
    expect(generateReferenceTransactions()).toHaveLength(REFERENCE_TRANSACTION_COUNT);
  });

  it('is deterministic — TS-23: the fixed seed is what makes nightly numbers comparable', () => {
    const assets = generateReferenceAssets();
    expect(generateReferenceTransactions(assets)).toEqual(generateReferenceTransactions(assets));
  });

  it('stays within the 5-year reference window', () => {
    for (const tx of generateReferenceTransactions()) {
      expect(BusinessDate.compare(tx.date, REFERENCE_START_DATE)).toBeGreaterThanOrEqual(0);
      expect(BusinessDate.compare(tx.date, REFERENCE_AS_OF_DATE)).toBeLessThanOrEqual(0);
    }
  });

  it('never sells a ticker before it has been bought — an internally valid ledger', () => {
    const seenByTicker = new Map<string, boolean>();
    for (const tx of generateReferenceTransactions()) {
      const alreadyBought = seenByTicker.get(tx.ticker) ?? false;
      if (tx.kind === 'sell') {
        expect(alreadyBought, `${tx.ticker} sold before any recorded buy`).toBe(true);
      }
      seenByTicker.set(tx.ticker, true);
    }
  });

  it('every transaction references a generated asset', () => {
    const assets = generateReferenceAssets();
    const tickers = new Set(assets.map((a) => a.ticker));
    for (const tx of generateReferenceTransactions(assets)) {
      expect(tickers.has(tx.ticker)).toBe(true);
    }
  });

  it('quantities and prices are positive integers, never a float that could hide AR-06 drift', () => {
    for (const tx of generateReferenceTransactions().slice(0, 200)) {
      expect(Number.isInteger(tx.quantity)).toBe(true);
      expect(tx.quantity).toBeGreaterThan(0);
      expect(Number.isInteger(tx.unitPriceCents)).toBe(true);
      expect(tx.unitPriceCents).toBeGreaterThan(0);
    }
  });
});

describe('generateReferenceWorkload', () => {
  it('bundles the same deterministic assets and transactions', () => {
    const workload = generateReferenceWorkload();
    expect(workload.assets).toHaveLength(REFERENCE_ASSET_COUNT);
    expect(workload.transactions).toHaveLength(REFERENCE_TRANSACTION_COUNT);
  });
});

describe('centsToDecimalString', () => {
  it('converts by integer arithmetic, never by dividing (AR-06)', () => {
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(100)).toBe('1.00');
    expect(centsToDecimalString(50_000)).toBe('500.00');
    expect(centsToDecimalString(123_456)).toBe('1234.56');
  });

  it('keeps the sign on the outside', () => {
    expect(centsToDecimalString(-5)).toBe('-0.05');
    expect(centsToDecimalString(-123_456)).toBe('-1234.56');
  });

  it('produces a literal Money accepts', () => {
    // The whole point of the string: `Money.fromString` is the only way a
    // value enters the ledger, and it refuses anything exponential or lossy.
    for (const cents of [1, 99, 100, 101, 999_999_99]) {
      expect(Money.fromString(centsToDecimalString(cents)).toString()).toBe(
        centsToDecimalString(cents).replace(/\.00$/, ''),
      );
    }
  });
});

describe('referenceTransactionRows', () => {
  const workload = generateReferenceWorkload();
  const assetIds = new Map(
    workload.assets.map((asset, index) => [
      asset.ticker,
      AssetId.of(`0192${String(index).padStart(4, '0')}-0000-7000-8000-000000000001`),
    ]),
  );
  const userId = UserId.of('00000000-0000-7000-8000-000000000001');

  it('maps every generated transaction', () => {
    expect(referenceTransactionRows(workload.transactions, assetIds, userId)).toHaveLength(
      REFERENCE_TRANSACTION_COUNT,
    );
  });

  /**
   * BR-006-04's constraint is `UNIQUE (user_id, natural_key, occurrence)`, and
   * the generator can legitimately produce two identical rows for one ticker
   * on one day. A collision here is not a test failure in the abstract — it is
   * the nightly seed aborting halfway through, leaving the budgets measured
   * against a partial workload.
   */
  it('produces a natural key per row that no other row shares', () => {
    const rows = referenceTransactionRows(workload.transactions, assetIds, userId);
    expect(new Set(rows.map((row) => `${row.naturalKey}|${row.occurrence ?? 1}`)).size).toBe(
      rows.length,
    );
  });

  it('is a pure function of the workload, so a re-seed writes the same keys', () => {
    // Ids differ (they are generated), but the keys the unique constraint sees
    // must not — otherwise a re-run is not idempotent in the way the seeder's
    // count check assumes.
    const first = referenceTransactionRows(workload.transactions, assetIds, userId);
    const second = referenceTransactionRows(workload.transactions, assetIds, userId);
    expect(first.map((row) => row.naturalKey)).toEqual(second.map((row) => row.naturalKey));
  });

  it('maps every asset class onto one the schema CHECK accepts', () => {
    for (const value of Object.values(REFERENCE_ASSET_CLASS_TO_SCHEMA)) {
      expect(ASSET_CLASSES as readonly string[]).toContain(value);
    }
    // And covers every class the generator can emit — a missing key would
    // insert `undefined` and fail the NOT NULL at seed time.
    for (const asset of workload.assets) {
      expect(REFERENCE_ASSET_CLASS_TO_SCHEMA[asset.assetClass]).toBeDefined();
    }
  });
});

/**
 * The property that was missing, and that let a fixture the position engine
 * refuses reach `main`.
 *
 * `seed-reference.ts` bulk-inserts these rows rather than putting them through
 * `createTransaction`, because that use case replays the whole position on
 * every call and seeding 10.000 rows through it would be quadratic. The
 * justification for skipping it was that the generator provides the same
 * guarantee structurally — and it did not: "the first row for a ticker is a
 * buy" says nothing about the fourth sale of 90 against a holding of 30.
 *
 * `pnpm positions:rebuild --user <reference> --dry-run` refused with
 * INSUFFICIENT_QUANTITY, which is exactly the right answer to a ledger that
 * cannot exist. This test is what makes that answer impossible to reach again
 * without a red build — and it costs one in-memory replay.
 */
describe('the generated ledger is one SPEC-007 can actually replay', () => {
  it('replays all 10.000 transactions without an impossible sale', () => {
    const workload = generateReferenceWorkload();
    const assetIds = new Map(
      workload.assets.map((asset, index) => [
        asset.ticker,
        AssetId.of(`0192${String(index).padStart(4, '0')}-0000-7000-8000-000000000001`),
      ]),
    );
    const rows = referenceTransactionRows(
      workload.transactions,
      assetIds,
      UserId.of('00000000-0000-7000-8000-000000000001'),
    );

    const replayed = replayPositions(
      rows.map((row) => ({
        ...row,
        ratio: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })) as never,
    );

    // Named, not just `.ok` — the error code is what says *which* rule the
    // fixture broke.
    expect(replayed.ok ? 'replayable' : replayed.error.code).toBe('replayable');
  });

  it('never lets a ticker be sold below zero', () => {
    // The same property stated directly, so a failure points at the generator
    // rather than at the engine.
    const { transactions } = generateReferenceWorkload();
    const held = new Map<string, number>();
    for (const transaction of transactions) {
      const holding = held.get(transaction.ticker) ?? 0;
      const next =
        transaction.kind === 'buy'
          ? holding + transaction.quantity
          : holding - transaction.quantity;
      expect(next, `${transaction.ticker} on ${transaction.date}`).toBeGreaterThanOrEqual(0);
      held.set(transaction.ticker, next);
    }
  });
});
