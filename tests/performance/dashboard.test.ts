import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import { UserId } from '@/core/shared/ids';
import { loadDashboard } from '@/app/(app)/dashboard/data';
import {
  REFERENCE_AS_OF_DATE,
  REFERENCE_TRANSACTION_COUNT,
  REFERENCE_USER_ID,
} from '@/db/reference-workload';

/**
 * **SPEC-016 BR-016-02 / PRD FR-8.29 — "dashboard loads in under 2s (p95) at
 * the reference workload".**
 *
 * This budget has been a live requirement since M0 with nothing to measure,
 * because there was no dashboard (#98). It is the tightest number in the
 * product — a second tighter than any report — which is why the screen it
 * governs was built to compute nothing: every figure on it is a re-presentation
 * of something a snapshot, a position cache or a reconciliation report already
 * holds.
 *
 * Nightly and advisory (DL-016-03, TS-31). The blocking half is
 * `tests/structural/reports-read-snapshots.test.ts`, which catches the
 * architectural cause — a ledger replay creeping into this read path — rather
 * than measuring the symptom.
 *
 * **This measures the loader, not the route.** Rendering, session resolution
 * and the network are not here, so the number is a floor on what the page can
 * cost rather than the page's own p95. It is still the number that moves when
 * a query starts scanning, which is what a nightly comparison is for.
 *
 * It fails loudly rather than skipping when the workload is absent: a
 * performance suite that silently measures nothing stays green forever and
 * nobody looks.
 */

/** BR-016-02. */
const BUDGET_MS = 2_000;
const SAMPLES = 20;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

describe('SPEC-016 FR-8.29 — the dashboard at reference scale (nightly, advisory)', () => {
  const userId = UserId.of(REFERENCE_USER_ID);
  /*
   * The workload's own as-of date, not the wall clock. Five years of generated
   * history ends on 2026-01-01; measuring "today" would value a portfolio
   * against a date the fixture says nothing about, and the number would drift
   * with the calendar rather than with the code.
   */
  const clock = new FakeClock(`${REFERENCE_AS_OF_DATE}T12:00:00Z`);

  let pool: Pool;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (url === undefined || url === '') {
      throw new Error('DATABASE_URL is not set — this suite measures a real database');
    }
    pool = new Pool({ connectionString: url, max: 4 });
    const database = drizzle(pool, { schema });

    const counts = await withTenant(
      userId,
      async (tx) => {
        const [transactions] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.transactions);
        const [positions] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(schema.positions);
        return { transactions: transactions?.total ?? 0, positions: positions?.total ?? 0 };
      },
      database,
    );

    if (counts.transactions < REFERENCE_TRANSACTION_COUNT) {
      throw new Error(
        `reference workload not seeded: ${counts.transactions} transactions, expected at least ` +
          `${REFERENCE_TRANSACTION_COUNT}. Run \`pnpm db:seed:reference\` first.`,
      );
    }

    /*
     * `pnpm db:seed:reference` deliberately writes no `positions` rows — SPEC-007
     * owns that table and DM-4 forbids a fixture asserting an average cost the
     * engine never computed. So the workload is populated by running SPEC-007's
     * own rebuild (`nightly.yml` does it in the step before this one), and
     * without it this suite would measure a dashboard for a tenant holding
     * nothing: fast, green, and meaningless.
     */
    if (counts.positions === 0) {
      throw new Error(
        'reference positions are empty — the dashboard would be measured against an empty ' +
          'portfolio. Run `pnpm positions:rebuild --user ' +
          `${REFERENCE_USER_ID}\` after seeding.`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('assembles the whole screen within budget', async () => {
    // One untimed pass first: the first query of a suite pays for connection
    // setup and a cold cache, and including it would make the p95 a statement
    // about process start rather than about the read path.
    await loadDashboard(userId, clock);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now();
      await loadDashboard(userId, clock);
      samples.push(performance.now() - started);
    }

    const p95 = percentile(samples, 0.95);
    console.info(`[budget] dashboard: p95 ${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(BUDGET_MS);
  });
});
