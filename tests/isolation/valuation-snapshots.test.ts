import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import * as schema from '@/db/schema';
import { dailyValuationSnapshots } from '@/db/schema/valuation';
import { withTenant } from '@/db/tenant';
import { UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';

/**
 * SPEC-009 / TS-13-15 — `daily_valuation_snapshots` is tenant-scoped, and the
 * enumeration gate blocks a merge until it is named by an isolation test.
 * This is that test.
 *
 * This table deserves the scrutiny as much as `positions` does, and for the
 * same reason: it is *derived*, which makes it tempting to treat as less
 * sensitive than the ledger it came from. It is not. One row states exactly
 * what one person's portfolio was worth on one day, how much they had put in,
 * and how much they had earned — no join required for any of it.
 */
describe('SPEC-009 — daily_valuation_snapshots tenant isolation', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    // TS-03: CI runs every suite against one shared Postgres, so another file
    // may have left rows behind. `resetUsers` cascades into this table.
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) =>
        tx.insert(dailyValuationSnapshots).values({
          userId: userA,
          date: '2026-03-20',
          totalValue: Money.fromString('25811.92970588'),
          netContributions: Money.fromString('24415'),
          earningsToDate: Money.fromString('103'),
          byAssetClass: { stock: '3842', tesouro_direto: '11947.95', cdb: '10021.97970588' },
          hasEstimates: true,
        }),
      appDb,
    );

    await withTenant(
      userB,
      async (tx) =>
        tx.insert(dailyValuationSnapshots).values({
          userId: userB,
          date: '2026-03-20',
          totalValue: Money.fromString('777.77'),
          netContributions: Money.fromString('700'),
          earningsToDate: Money.zero(),
          byAssetClass: { fii: '777.77' },
          hasEstimates: false,
        }),
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    // Both halves: this file's own rows go with the tenants it created, so a
    // later file enumerating the table does not inherit them (TS-03).
    await resetUsers(testDb.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered snapshot read returns only A’s day', async () => {
    // No WHERE user_id anywhere. The policy is what constrains this, which is
    // the entire point — a forgotten predicate must return nothing rather than
    // everything (PRD risk R6).
    const rows = await withTenant(
      userA,
      async (tx) => tx.select().from(dailyValuationSnapshots),
      appDb,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA);
    // `Money.toString()` emits the canonical decimal, not the column's
    // zero-padded form — NUMERIC(20,8) holds exactly these eight places.
    expect(rows[0]?.totalValue.toString()).toBe('25811.92970588');
    // B's portfolio is worth a distinguishable amount on the same date; none
    // of it may appear.
    expect(rows.some((row) => row.totalValue.toString().startsWith('777'))).toBe(false);
  });

  it('AR-06/AR-07: the NUMERIC round trip preserves every stored digit', async () => {
    // The figure written was 25811.92970588 — eight decimal places, which is
    // exactly what NUMERIC(20,8) holds. Postgres pads to the column scale, so
    // the string comes back zero-extended; the *value* must be unchanged.
    const rows = await withTenant(
      userA,
      async (tx) => tx.select().from(dailyValuationSnapshots),
      appDb,
    );
    expect(rows[0]?.totalValue.equals(Money.fromString('25811.92970588'))).toBe(true);
    // AR-10: jsonb comes back as strings, never as floats.
    const breakdown = rows[0]?.byAssetClass ?? {};
    expect(breakdown['cdb']).toBe('10021.97970588');
    for (const value of Object.values(breakdown)) expect(typeof value).toBe('string');
  });

  it('an aggregate over snapshots cannot see across the boundary (TS-14)', async () => {
    // TS-14: leaks happen in aggregates and exports, above where a repository
    // test looks. A SUM that silently included another tenant would produce a
    // plausible portfolio total, which is worse than an error.
    const result = await withTenant(
      userA,
      async (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n, sum(total_value) AS total FROM daily_valuation_snapshots`,
        ),
      appDb,
    );
    const row = result.rows[0] as { n: number; total: string | null };
    expect(row.n).toBe(1);
    expect(row.total).toBe('25811.92970588');
  });

  it('tenant A cannot insert a snapshot attributed to tenant B', async () => {
    // The WITH CHECK half. Without it, a read-side test still passes while A
    // quietly writes rows belonging to B. 42501 = insufficient_privilege.
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(dailyValuationSnapshots).values({
            userId: userB,
            date: '2026-03-21',
            totalValue: Money.fromString('1'),
            netContributions: Money.fromString('1'),
            earningsToDate: Money.zero(),
            byAssetClass: { stock: '1' },
            hasEstimates: false,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot update or delete tenant B’s snapshot', async () => {
    // BR-009-18's invalidation is an unqualified DELETE scoped only by RLS
    // (`deleteFrom`), so "the policy really does scope a bulk delete" is the
    // property that keeps one tenant's rebuild from wiping another's history.
    const updated = await withTenant(
      userA,
      async (tx) =>
        tx
          .update(dailyValuationSnapshots)
          .set({ totalValue: Money.fromString('0.01') })
          .returning({ date: dailyValuationSnapshots.date }),
      appDb,
    );
    expect(updated).toHaveLength(1);

    const deleted = await withTenant(
      userA,
      async (tx) =>
        tx.delete(dailyValuationSnapshots).returning({ date: dailyValuationSnapshots.date }),
      appDb,
    );
    expect(deleted).toHaveLength(1);

    // B's row survived both, untouched.
    const { rows } = await migratorPool.query<{ total_value: string; user_id: string }>(
      'SELECT user_id, total_value FROM daily_valuation_snapshots',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(userB);
    expect(rows[0]?.total_value).toBe('777.77000000');

    // Restore A's row so the ordering of the remaining tests does not depend
    // on this one having run (TS-03).
    await withTenant(
      userA,
      async (tx) =>
        tx.insert(dailyValuationSnapshots).values({
          userId: userA,
          date: '2026-03-20',
          totalValue: Money.fromString('25811.92970588'),
          netContributions: Money.fromString('24415'),
          earningsToDate: Money.fromString('103'),
          byAssetClass: { stock: '3842', tesouro_direto: '11947.95', cdb: '10021.97970588' },
          hasEstimates: true,
        }),
      appDb,
    );
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    // `app.user_id` is never set, so `current_setting(...)::uuid` raises rather
    // than matching. Failing closed is the property being asserted.
    await expect(appDb.select().from(dailyValuationSnapshots)).rejects.toThrow();
  });

  it('has ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname = 'daily_valuation_snapshots'
             AND relnamespace = 'public'::regnamespace`,
    );
    const row = result.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
    // FORCE matters as much as ENABLE: migrations run as the owner, and an
    // owner bypasses its own policies without it.
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it('the policy covers both reads and writes', async () => {
    const result = await migratorDb.execute(
      sql`SELECT qual, with_check FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'daily_valuation_snapshots'`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      qual: string | null;
      with_check: string | null;
    }>;
    expect(rows.some((row) => row.qual !== null && row.with_check !== null)).toBe(true);
  });

  it('deleting the tenant root removes its snapshots, so account deletion is complete', async () => {
    // AR-27: the ON DELETE CASCADE is load-bearing for SPEC-004. Asserting it
    // against the real schema beats inferring it from the column definition —
    // a derived cache surviving an account deletion would leave the person's
    // portfolio history behind after they asked for it to be erased.
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);
    await withTenant(
      doomed,
      async (tx) =>
        tx.insert(dailyValuationSnapshots).values({
          userId: doomed,
          date: '2026-03-20',
          totalValue: Money.fromString('42'),
          netContributions: Money.fromString('42'),
          earningsToDate: Money.zero(),
          byAssetClass: { stock: '42' },
          hasEstimates: false,
        }),
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const { rows } = await migratorPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM daily_valuation_snapshots WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
