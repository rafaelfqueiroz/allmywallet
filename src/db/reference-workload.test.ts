import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import {
  REFERENCE_ASSET_COUNT,
  REFERENCE_AS_OF_DATE,
  REFERENCE_START_DATE,
  REFERENCE_TRANSACTION_COUNT,
  generateReferenceAssets,
  generateReferenceTransactions,
  generateReferenceWorkload,
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
