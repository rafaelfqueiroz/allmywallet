import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { listTransactions } from '@/core/ledger/list-transactions';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { paginationFor } from '@/lib/transactions-url-state';
import { REFERENCE_TRANSACTION_COUNT, REFERENCE_USER_ID } from '@/db/reference-workload';

/**
 * SPEC-006's first acceptance criterion, budget half — "the transaction list
 * … loads within the SPEC performance budget", measured at BR-016-01's named
 * scale.
 *
 * Nightly and advisory (DL-016-03): per-PR measurement would need the seeded
 * reference workload on every push, which is too slow to tolerate and would be
 * switched off within a month. The blocking half — that the list is *correct*
 * over 10.000 rows — is `tests/integration/transaction-pagination.test.ts`.
 *
 * Runs against whatever `pnpm db:seed:reference` left behind, which
 * `nightly.yml` runs in the step before this one. It fails loudly rather than
 * skipping when the workload is absent: a performance suite that silently
 * measures nothing is worse than one that is red, because it stays green
 * forever and nobody looks.
 *
 * **This measures the query, not the page.** The number below is a floor on
 * what the route can cost, not the route's own p95 — rendering, session
 * resolution and the network are not here. It is still the number that moves
 * when an index is dropped or a filter starts scanning, which is what a
 * nightly comparison is for.
 */

/** BR-016-02's dashboard budget, the tightest of the two SPEC-016 states. */
const BUDGET_MS = 2_000;
const SAMPLES = 20;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

describe('SPEC-006 — the transaction list at reference scale (nightly, advisory)', () => {
  const userId = UserId.of(REFERENCE_USER_ID);
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url === '') {
      throw new Error('DATABASE_URL is not set — this suite measures a real database');
    }
    pool = new Pool({ connectionString: url, max: 4 });
    db = drizzle(pool, { schema });

    const total = await withTenant(
      userId,
      async (tx) => {
        const [row] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.transactions);
        return row?.total ?? 0;
      },
      db,
    );

    if (total < REFERENCE_TRANSACTION_COUNT) {
      throw new Error(
        `reference workload not seeded: ${total} transactions, expected at least ` +
          `${REFERENCE_TRANSACTION_COUNT}. Run \`pnpm db:seed:reference\` first.`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function measure(run: () => Promise<unknown>): Promise<readonly number[]> {
    // One untimed pass first: the first query of a suite pays for connection
    // setup and a cold cache, and including it would make the p95 a statement
    // about process start rather than about the query.
    await run();
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const started = performance.now();
      await run();
      samples.push(performance.now() - started);
    }
    return samples;
  }

  function listAt(page: number, filter = {}) {
    return withTenant(
      userId,
      (tx) =>
        listTransactions(new DrizzleTransactionRepository(tx, userId), filter, paginationFor(page)),
      db,
    );
  }

  it('serves the first page within budget', async () => {
    const samples = await measure(() => listAt(1));
    const p95 = percentile(samples, 0.95);
    console.info(`[budget] transaction list, first page: p95 ${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(BUDGET_MS);
  });

  it('serves a deep page within budget', async () => {
    // OFFSET grows linearly with the page, and this is where that shows: the
    // last page of 10.000 rows is the worst case the current LIMIT/OFFSET
    // scheme has, and the number to watch if keyset pagination ever becomes
    // necessary.
    const lastPage = Math.ceil(REFERENCE_TRANSACTION_COUNT / 50);
    const samples = await measure(() => listAt(lastPage));
    const p95 = percentile(samples, 0.95);
    console.info(`[budget] transaction list, page ${lastPage}: p95 ${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(BUDGET_MS);
  });

  it('serves a searched page within budget', async () => {
    // BR-006-09's ILIKE over code and name, which is the filter with no index
    // behind it — the one most likely to be the first to miss the budget.
    const samples = await measure(() => listAt(1, { search: 'REF01' }));
    const p95 = percentile(samples, 0.95);
    console.info(`[budget] transaction list, search: p95 ${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(BUDGET_MS);
  });
});
