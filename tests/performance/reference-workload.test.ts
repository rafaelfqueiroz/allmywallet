import { describe, expect, it } from 'vitest';
import {
  REFERENCE_ASSET_COUNT,
  REFERENCE_TRANSACTION_COUNT,
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
