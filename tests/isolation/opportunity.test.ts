import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetOpportunity, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';
import * as schema from '@/db/schema';
import { opportunityNotifications, opportunityRules } from '@/db/schema/opportunity';
import { withTenant } from '@/db/tenant';
import type { AssetId } from '@/core/shared/ids';
import { OpportunityNotificationId, OpportunityRuleId, UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';

/**
 * TS-13/TS-15 — `opportunity_rules` and `opportunity_notifications`
 * (SPEC-018, #90) are tenant-scoped tables; the enumeration gate
 * (`tests/isolation/enumeration.test.ts`) blocks a merge until each is named
 * by an isolation test with its own coverage. This is that test.
 *
 * A rule states the exact prices one person is watching on their own
 * holdings, and a notification is a record of every email that told them a
 * threshold had been crossed — as personal as the position being watched.
 *
 * `core/opportunity` and `src/adapters/db` repositories for these tables do
 * not exist yet (parallel work, #90), so this file writes rows with plain
 * Drizzle inserts inside `withTenant` rather than through a repository.
 */
describe('SPEC-018 — opportunity_rules and opportunity_notifications, isolated', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let migratorPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;
  let migratorDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  const ruleA = OpportunityRuleId.generate();
  const ruleB = OpportunityRuleId.generate();
  const notificationA = OpportunityNotificationId.generate();
  const notificationB = OpportunityNotificationId.generate();
  let petr: AssetId;
  let vale: AssetId;

  async function cleanup(): Promise<void> {
    // TS-03: CI runs these suites against one shared Postgres service
    // container, so another file may have left rows behind, and this file
    // must not leave any for the next one.
    await resetOpportunity(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);

    appPool = new Pool({ connectionString: testDb.appUrl, max: 1 });
    migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    appDb = drizzle(appPool, { schema });
    migratorDb = drizzle(migratorPool, { schema });

    await cleanup();
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);

    const petrAsset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    petr = petrAsset.id;
    const valeAsset = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');
    vale = valeAsset.id;

    // TS-15: distinguishable data per tenant, written as each tenant.
    await withTenant(
      userA,
      async (tx) => {
        await tx.insert(opportunityRules).values({
          id: ruleA,
          userId: userA,
          assetId: petr,
          lowerBound: Money.fromString('30'),
          lowerState: 'buy',
          upperBound: Money.fromString('45'),
          upperState: 'sell',
          defaultState: 'hold',
          lastState: 'hold',
          lastEvaluatedAt: new Date('2026-08-01T13:00:00Z'),
          active: true,
          muted: false,
        });
        await tx.insert(opportunityNotifications).values({
          id: notificationA,
          userId: userA,
          ruleId: ruleA,
          state: 'buy',
          quoteObservedAt: new Date('2026-08-01T13:00:00Z'),
          sentAt: new Date('2026-08-01T13:05:00Z'),
        });
      },
      appDb,
    );

    await withTenant(
      userB,
      async (tx) => {
        await tx.insert(opportunityRules).values({
          id: ruleB,
          userId: userB,
          assetId: vale,
          lowerBound: Money.fromString('60'),
          lowerState: 'sell',
          upperBound: null,
          upperState: null,
          defaultState: 'hold',
          lastState: null,
          lastEvaluatedAt: null,
          active: true,
          muted: false,
        });
        await tx.insert(opportunityNotifications).values({
          id: notificationB,
          userId: userB,
          ruleId: ruleB,
          state: 'sell',
          quoteObservedAt: new Date('2026-08-02T14:00:00Z'),
          sentAt: new Date('2026-08-02T14:05:00Z'),
        });
      },
      appDb,
    );
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await appPool.end();
    await migratorPool.end();
    await testDb.stop();
  });

  it('as tenant A, an unfiltered opportunity_rules read returns only A’s rule', async () => {
    const rows = await withTenant(userA, async (tx) => tx.select().from(opportunityRules), appDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ruleA);
    expect(rows.some((row) => row.id === ruleB)).toBe(false);
  });

  it('as tenant A, an unfiltered opportunity_notifications read returns only A’s notification', async () => {
    const rows = await withTenant(
      userA,
      async (tx) => tx.select().from(opportunityNotifications),
      appDb,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(notificationA);
    expect(rows.some((row) => row.id === notificationB)).toBe(false);
  });

  it('an aggregate over opportunity_rules cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n, sum(lower_bound) AS total FROM opportunity_rules`,
        ),
      appDb,
    );
    const row = result.rows[0] as { n: number; total: string | null };
    // A's 30 alone. B's 60 would make this 90 and would be invisible as a
    // leak — the aggregate hides which rows it read.
    expect(row.n).toBe(1);
    expect(row.total).toBe('30.00000000');
  });

  it('an aggregate over opportunity_notifications cannot see across the boundary (TS-14)', async () => {
    const result = await withTenant(
      userA,
      async (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM opportunity_notifications`),
      appDb,
    );
    expect((result.rows[0] as { n: number }).n).toBe(1);
  });

  it('tenant A cannot insert an opportunity_rule attributed to tenant B', async () => {
    // 42501 = insufficient_privilege — the WITH CHECK half of the policy.
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(opportunityRules).values({
            id: OpportunityRuleId.generate(),
            userId: userB,
            assetId: petr,
            lowerBound: Money.fromString('1'),
            lowerState: 'buy',
            upperBound: null,
            upperState: null,
            defaultState: 'hold',
            lastState: null,
            lastEvaluatedAt: null,
            active: true,
            muted: false,
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('tenant A cannot insert an opportunity_notification attributed to tenant B', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(opportunityNotifications).values({
            id: OpportunityNotificationId.generate(),
            userId: userB,
            ruleId: ruleA,
            state: 'buy',
            quoteObservedAt: new Date('2026-08-03T13:00:00Z'),
            sentAt: new Date('2026-08-03T13:05:00Z'),
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a query outside withTenant fails rather than returning everything (TS-16)', async () => {
    await expect(appDb.select().from(opportunityRules)).rejects.toThrow();
    await expect(appDb.select().from(opportunityNotifications)).rejects.toThrow();
  });

  it('both tables have ENABLE and FORCE row level security', async () => {
    const result = await migratorDb.execute(
      sql`SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
           WHERE relname IN ('opportunity_rules', 'opportunity_notifications')
             AND relnamespace = 'public'::regnamespace
           ORDER BY relname`,
    );
    const rows = result.rows as unknown as ReadonlyArray<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it('deleting the tenant root removes both, so account deletion is complete (AR-27)', async () => {
    const doomed = UserId.generate();
    await seedUser(testDb.migrationUrl, doomed);
    const doomedRule = OpportunityRuleId.generate();

    await withTenant(
      doomed,
      async (tx) => {
        await tx.insert(opportunityRules).values({
          id: doomedRule,
          userId: doomed,
          assetId: petr,
          lowerBound: Money.fromString('1'),
          lowerState: 'buy',
          upperBound: null,
          upperState: null,
          defaultState: 'hold',
          lastState: null,
          lastEvaluatedAt: null,
          active: true,
          muted: false,
        });
        await tx.insert(opportunityNotifications).values({
          id: OpportunityNotificationId.generate(),
          userId: doomed,
          ruleId: doomedRule,
          state: 'buy',
          quoteObservedAt: new Date('2026-08-04T13:00:00Z'),
          sentAt: new Date('2026-08-04T13:05:00Z'),
        });
      },
      appDb,
    );

    await migratorPool.query('DELETE FROM users WHERE id = $1', [doomed]);

    const rules = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM opportunity_rules WHERE user_id = $1',
      [doomed],
    );
    expect(Number(rules.rows[0]?.n)).toBe(0);
    const notifications = await migratorPool.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM opportunity_notifications WHERE user_id = $1',
      [doomed],
    );
    expect(Number(notifications.rows[0]?.n)).toBe(0);
  });

  /**
   * BR-018-24/DL-018-08 — the idempotency key that stops an at-least-once
   * retry from resending an email for the same observation, asserted here
   * because it is a property of the tenant-scoped write path this file
   * already exercises, not a separate concern.
   */
  it('a second notification for the same rule, state and observation is refused (BR-018-24)', async () => {
    await expect(
      withTenant(
        userA,
        async (tx) =>
          tx.insert(opportunityNotifications).values({
            id: OpportunityNotificationId.generate(),
            userId: userA,
            ruleId: ruleA,
            state: 'buy',
            // Same observation as the seeded notificationA row.
            quoteObservedAt: new Date('2026-08-01T13:00:00Z'),
            sentAt: new Date('2026-08-01T14:00:00Z'),
          }),
        appDb,
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
