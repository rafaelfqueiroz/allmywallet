import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import type { AssetId } from '@/core/shared/ids';
import { OpportunityNotificationId, OpportunityRuleId, UserId } from '@/core/shared/ids';
import { Money } from '@/core/shared/money';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleOpportunityNotificationLog } from '@/adapters/db/opportunity-notification-repository';
import type { OpportunityRule } from '@/core/opportunity/ports';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetOpportunity, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';

/**
 * SPEC-018 — `DrizzleOpportunityRuleRepository` and
 * `DrizzleOpportunityNotificationLog` against real Postgres (TESTING §1):
 * `NUMERIC(20,8)` ⇄ `Money` round-tripping for both bounds, and `claim`'s
 * conflict behaviour under a *genuine* duplicate insert — neither is provable
 * against a fake.
 *
 * TS-03/TS-33: truncates in both `beforeAll` and `afterAll`; every file in
 * this suite shares one Postgres in CI.
 */
describe('SPEC-018 — opportunity repositories (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let assetId: AssetId;

  async function cleanup(): Promise<void> {
    await resetOpportunity(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await cleanup();
    await seedUser(testDb.migrationUrl, userId);
    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    assetId = asset.id;

    pool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await resetOpportunity(testDb.migrationUrl);
  });

  function ruleRepo(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    return new DrizzleOpportunityRuleRepository(tx, userId);
  }

  function logRepo(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    return new DrizzleOpportunityNotificationLog(tx, userId);
  }

  function aRule(overrides: Partial<OpportunityRule> = {}): OpportunityRule {
    return {
      id: OpportunityRuleId.generate(),
      userId,
      assetId,
      lower: { price: Money.fromString('30.12345678'), state: 'buy' },
      upper: { price: Money.fromString('45.87654321'), state: 'sell' },
      defaultState: 'hold',
      lastState: null,
      lastEvaluatedAt: null,
      active: true,
      muted: false,
      ...overrides,
    };
  }

  it('round-trips both bounds exactly through NUMERIC(20,8), long decimal tails included', async () => {
    const rule = aRule();
    await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);

    const found = await withTenant(userId, (tx) => ruleRepo(tx).findByAsset(assetId), db);
    expect(found?.lower?.price.toString()).toBe('30.12345678');
    expect(found?.lower?.state).toBe('buy');
    expect(found?.upper?.price.toString()).toBe('45.87654321');
    expect(found?.upper?.state).toBe('sell');
  });

  it('round-trips a rule with only a lower bound — the upper side reads back entirely null', async () => {
    const rule = aRule({ upper: null });
    await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);

    const found = await withTenant(userId, (tx) => ruleRepo(tx).findByAsset(assetId), db);
    expect(found?.upper).toBeNull();
    expect(found?.lower?.price.toString()).toBe('30.12345678');
  });

  it('update() changes only bounds/defaultState/muted, leaving active and lastState untouched', async () => {
    const rule = aRule();
    await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);
    await withTenant(
      userId,
      (tx) => ruleRepo(tx).recordObservation(rule.id, 'hold', new Date('2026-03-16T13:00:00Z')),
      db,
    );

    const updated: OpportunityRule = {
      ...rule,
      lower: { price: Money.fromString('31'), state: 'buy' },
      muted: true,
    };
    await withTenant(userId, (tx) => ruleRepo(tx).update(updated), db);

    const found = await withTenant(userId, (tx) => ruleRepo(tx).findByAsset(assetId), db);
    expect(found?.lower?.price.toString()).toBe('31');
    expect(found?.muted).toBe(true);
    // Untouched by `update` — still whatever `recordObservation` set.
    expect(found?.lastState).toBe('hold');
    expect(found?.active).toBe(true);
  });

  it('recordObservation writes last_state and last_evaluated_at together (BR-018-13)', async () => {
    const rule = aRule();
    await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);

    const at = new Date('2026-03-16T13:05:00Z');
    await withTenant(userId, (tx) => ruleRepo(tx).recordObservation(rule.id, 'sell', at), db);

    const found = await withTenant(userId, (tx) => ruleRepo(tx).findByAsset(assetId), db);
    expect(found?.lastState).toBe('sell');
    expect(found?.lastEvaluatedAt?.toISOString()).toBe(at.toISOString());
  });

  it('setActive batches activate/deactivate across multiple rules', async () => {
    const asset2 = await seedAsset(testDb.migrationUrl, 'VALE3', 'Vale ON');
    const ruleA = aRule();
    const ruleB = aRule({ id: OpportunityRuleId.generate(), assetId: asset2.id, active: false });
    await withTenant(
      userId,
      async (tx) => {
        await ruleRepo(tx).insert(ruleA);
        await ruleRepo(tx).insert(ruleB);
      },
      db,
    );

    await withTenant(userId, (tx) => ruleRepo(tx).setActive([ruleA.id], false), db);
    await withTenant(userId, (tx) => ruleRepo(tx).setActive([ruleB.id], true), db);

    const all = await withTenant(userId, (tx) => ruleRepo(tx).listAll(), db);
    const foundA = all.find((r) => r.id === ruleA.id);
    const foundB = all.find((r) => r.id === ruleB.id);
    expect(foundA?.active).toBe(false);
    expect(foundB?.active).toBe(true);
  });

  it('listActiveForAssets returns only active rules among the requested assets', async () => {
    const asset2 = await seedAsset(testDb.migrationUrl, 'HGLG11', 'CSHG Logística FII');
    const active = aRule();
    const inactive = aRule({ id: OpportunityRuleId.generate(), assetId: asset2.id, active: false });
    await withTenant(
      userId,
      async (tx) => {
        await ruleRepo(tx).insert(active);
        await ruleRepo(tx).insert(inactive);
      },
      db,
    );

    const found = await withTenant(
      userId,
      (tx) => ruleRepo(tx).listActiveForAssets([assetId, asset2.id]),
      db,
    );
    expect(found.map((r) => r.id)).toEqual([active.id]);
  });

  describe('DrizzleOpportunityNotificationLog.claim — DL-018-08', () => {
    it('the first claim on an observation succeeds; a genuine duplicate insert is refused, not merely detected after the fact', async () => {
      const rule = aRule();
      await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);

      const entry = {
        id: OpportunityNotificationId.generate(),
        userId,
        ruleId: rule.id,
        state: 'buy' as const,
        quoteObservedAt: new Date('2026-03-16T13:00:00Z'),
        sentAt: new Date('2026-03-16T13:00:05Z'),
      };

      const first = await withTenant(userId, (tx) => logRepo(tx).claim(entry), db);
      expect(first).toBe(true);

      // A second attempt at the *exact* same (ruleId, state, quoteObservedAt)
      // — a different notification id, simulating a retried job that
      // generated a fresh id but is otherwise claiming the same observation.
      const retry = {
        ...entry,
        id: OpportunityNotificationId.generate(),
        sentAt: new Date('2026-03-16T13:05:00Z'),
      };
      const second = await withTenant(userId, (tx) => logRepo(tx).claim(retry), db);
      expect(second).toBe(false);

      // Exactly one row exists for this observation — `ON CONFLICT DO
      // NOTHING` refused the retry's insert outright rather than the
      // application layer deciding after the fact not to send twice.
      const lastSentAt = await withTenant(userId, (tx) => logRepo(tx).lastSentAt(rule.id), db);
      expect(lastSentAt?.toISOString()).toBe(entry.sentAt.toISOString());
    });

    it('a different state for the same observation is a distinct claim (state is part of the key)', async () => {
      const rule = aRule();
      await withTenant(userId, (tx) => ruleRepo(tx).insert(rule), db);
      const quoteObservedAt = new Date('2026-03-16T13:00:00Z');

      const buyClaim = await withTenant(
        userId,
        (tx) =>
          logRepo(tx).claim({
            id: OpportunityNotificationId.generate(),
            userId,
            ruleId: rule.id,
            state: 'buy',
            quoteObservedAt,
            sentAt: new Date('2026-03-16T13:00:05Z'),
          }),
        db,
      );
      const sellClaim = await withTenant(
        userId,
        (tx) =>
          logRepo(tx).claim({
            id: OpportunityNotificationId.generate(),
            userId,
            ruleId: rule.id,
            state: 'sell',
            quoteObservedAt,
            sentAt: new Date('2026-03-16T13:00:06Z'),
          }),
        db,
      );

      expect(buyClaim).toBe(true);
      expect(sellClaim).toBe(true);
    });

    it('lastSentAtByRule returns MAX(sent_at) grouped per rule', async () => {
      const asset2 = await seedAsset(testDb.migrationUrl, 'ITSA4', 'Itaúsa PN');
      const ruleA = aRule();
      const ruleB = aRule({ id: OpportunityRuleId.generate(), assetId: asset2.id });
      await withTenant(
        userId,
        async (tx) => {
          await ruleRepo(tx).insert(ruleA);
          await ruleRepo(tx).insert(ruleB);
        },
        db,
      );

      const earlier = new Date('2026-03-16T10:00:00Z');
      const later = new Date('2026-03-16T14:00:00Z');
      await withTenant(
        userId,
        async (tx) => {
          const log = logRepo(tx);
          await log.claim({
            id: OpportunityNotificationId.generate(),
            userId,
            ruleId: ruleA.id,
            state: 'buy',
            quoteObservedAt: earlier,
            sentAt: earlier,
          });
          await log.claim({
            id: OpportunityNotificationId.generate(),
            userId,
            ruleId: ruleA.id,
            state: 'sell',
            quoteObservedAt: later,
            sentAt: later,
          });
        },
        db,
      );

      const byRule = await withTenant(
        userId,
        (tx) => logRepo(tx).lastSentAtByRule([ruleA.id, ruleB.id]),
        db,
      );
      expect(byRule.get(ruleA.id)?.toISOString()).toBe(later.toISOString());
      expect(byRule.has(ruleB.id)).toBe(false);
    });
  });
});
