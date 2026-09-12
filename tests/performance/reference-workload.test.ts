import { describe, expect, it } from 'vitest';
import {
  REFERENCE_ASSET_COUNT,
  REFERENCE_AS_OF_DATE,
  REFERENCE_START_DATE,
  REFERENCE_TRANSACTION_COUNT,
  generateReferenceQuotes,
  generateReferenceWorkload,
} from '@/db/reference-workload';

/**
 * TS-23 / TESTING §8 — the nightly, advisory performance suite.
 *
 * The report budgets it will eventually carry (dashboard < 2s p95, any report
 * < 3s p95, import preview 10k rows < 30s, commit < 60s) cannot be measured
 * yet: the reports are SPEC-012..015 (#15–#18) and the import is SPEC-005
 * (#8). What *can* be measured today is the property every one of those future
 * numbers depends on — that the workload is identical from run to run.
 *
 * This is not a placeholder. If generation stops being deterministic, every
 * nightly comparison silently becomes meaningless: a "regression" would just be
 * a different workload, and a real regression would hide inside the noise.
 * Nobody would notice, because the suite would still be green.
 */
describe('reference workload — the basis for every nightly comparison', () => {
  it('generates the workload SPEC-016 states its budgets against', () => {
    const workload = generateReferenceWorkload();
    expect(workload.assets).toHaveLength(REFERENCE_ASSET_COUNT);
    expect(workload.transactions).toHaveLength(REFERENCE_TRANSACTION_COUNT);
  });

  it('is byte-for-byte identical across runs (TS-23)', () => {
    // The whole point of a fixed seed. Compared as serialised JSON rather than
    // with a structural matcher, because a difference in ordering is just as
    // damaging to a timing comparison as a difference in content.
    const first = JSON.stringify(generateReferenceWorkload());
    const second = JSON.stringify(generateReferenceWorkload());
    expect(first).toBe(second);
  });

  it('spreads transactions across the full history rather than bunching them', () => {
    // A workload where all 10,000 transactions land on one date would measure
    // nothing useful about five years of history — the index behaviour that
    // actually degrades would never be exercised.
    const { transactions } = generateReferenceWorkload();
    const dates = new Set(transactions.map((t) => t.date));
    expect(dates.size).toBeGreaterThan(500);
  });

  it('covers every asset, so no report is measured against a sparse portfolio', () => {
    const { assets, transactions } = generateReferenceWorkload();
    const touched = new Set(transactions.map((t) => t.ticker));
    expect(touched.size).toBe(assets.length);
  });

  /**
   * #98 — the price history the budgets are measured against.
   *
   * Before it existed, `pnpm db:seed:reference` wrote no quotes at all, so every
   * holding in the reference portfolio took SPEC-009's `COST_FALLBACK`: the
   * nightly run measured a dashboard and four reports that never priced
   * anything. Green, fast, and a statement about a code path production does
   * not take.
   */
  describe('the price history (#98)', () => {
    it('prices the market-traded classes and leaves the accrued ones to accrual', () => {
      const quotes = generateReferenceQuotes();
      const tickers = new Set(quotes.map((quote) => quote.ticker));

      /*
       * 100 assets cycling through 8 classes, and `acao`/`fii`/`bdr`/`etf` are
       * the first four of that cycle — so twelve whole blocks of eight give
       * 12 × 4 = 48, and the remaining four indices (96–99) land on all four
       * again: **52**. The other 48 are CDB/LCI/LCA/Tesouro, deliberately
       * unquoted, because that is the path BR-009-11's accrual and BR-009-13's
       * fallback live on — a workload that quoted everything would measure
       * neither.
       */
      expect(tickers.size).toBe(52);
      expect(quotes.length).toBeGreaterThan(50_000);
    });

    it('covers the whole history, weekdays only', () => {
      const quotes = generateReferenceQuotes();
      const dates = [...new Set(quotes.map((quote) => quote.date))].sort();

      // 2021-01-02 is a Saturday, so the history opens on the Monday. That is
      // the weekday rule working, not the range being short.
      expect(dates[0]).toBe('2021-01-04');
      expect(REFERENCE_START_DATE.localeCompare(dates[0] ?? '')).toBeLessThanOrEqual(0);
      expect(dates.at(-1)?.localeCompare(REFERENCE_AS_OF_DATE)).toBeLessThanOrEqual(0);
      // Saturdays and Sundays carry no close, which is what makes BR-009-03's
      // carry-forward a path the measurement actually takes.
      for (const date of dates) {
        const weekday = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
        expect(weekday, date).not.toBe(0);
        expect(weekday, date).not.toBe(6);
      }
    });

    it('never produces a zero or negative close', () => {
      // A walk that reached zero would make the rest of that asset's history
      // meaningless, and a zero close is not a thing a listed instrument has.
      expect(generateReferenceQuotes().every((quote) => quote.closeCents > 0)).toBe(true);
    });

    it('is byte-for-byte identical across runs (TS-23)', () => {
      expect(JSON.stringify(generateReferenceQuotes())).toBe(
        JSON.stringify(generateReferenceQuotes()),
      );
    });
  });

  it('generates within a budget that keeps the nightly run worth running', () => {
    // Generation is pure CPU and happens before anything is measured. It is
    // not itself a product budget — it is here so that a change making the
    // generator quadratic shows up as a failing test rather than as a nightly
    // job that quietly takes an hour.
    const started = performance.now();
    generateReferenceWorkload();
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
