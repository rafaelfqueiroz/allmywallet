import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { positions } from '@/db/schema/positions';
import { withTenant } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { ConsentId, OpportunityRuleId, PositionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import type { OpportunityRule } from '@/core/opportunity/ports';
import { FakeOpportunityNotifier } from '@/core/opportunity/test-support';
import { FakeTradingCalendar } from '@/core/quotes/test-support';
import { handleOpportunityEvaluate } from '@/worker/handlers/opportunity';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleOpportunityNotificationLog } from '@/adapters/db/opportunity-notification-repository';
import {
  DrizzleHeldAssetReader,
  DrizzleStoredQuoteReader,
} from '@/adapters/db/opportunity-read-adapters';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import {
  resetConfigState,
  resetConsents,
  resetLedger,
  resetOpportunity,
  resetUsers,
} from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset } from '../support/ledger-fixtures';

/**
 * SPEC-018 `opportunity.evaluate` — `handleOpportunityEvaluate`'s own added
 * behaviour, on top of what `tests/integration/opportunity-evaluation.test.ts`
 * already proves about `evaluateOpportunities` itself: the cross-tenant
 * `users` walk (ARCHITECTURE §5) and the two config reads
 * (`quotes.cadence_minutes` via `resolveQuoteBudgetConfig`,
 * `notifications.opportunity_cooldown_hours` inside each tenant's own
 * `withTenant`). Two tenants hold rules on the *same* polled asset; the test
 * proves each is evaluated against their own rule and their own consent,
 * never the other's.
 *
 * **Two pools, deliberately** (`seedPool` for setup, `handlerPool` for the one
 * call under test) — see the big comment on `handlerPool` below for why. This
 * is a genuine, separately-reported defect in `src/config/resolve.ts`
 * (outside this dispatch's scope), not a workaround for anything specific to
 * this feature.
 *
 * TS-03/TS-33: truncates in both `beforeAll` and `afterAll`.
 */
describe('SPEC-018 — handleOpportunityEvaluate (integration)', () => {
  let testDb: TestDatabase;
  let seedPool: Pool;
  let seedDb: ReturnType<typeof drizzle<typeof schema>>;

  const userA = UserId.generate();
  const userB = UserId.generate();
  let assetId: AssetId;

  async function cleanup(): Promise<void> {
    await resetOpportunity(testDb.migrationUrl);
    await resetConsents(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await cleanup();
    await seedUser(testDb.migrationUrl, userA);
    await seedUser(testDb.migrationUrl, userB);
    const asset = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');
    assetId = asset.id;

    seedPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    seedDb = drizzle(seedPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await seedPool.end();
    await testDb.stop();
  });

  beforeEach(async () => {
    await resetOpportunity(testDb.migrationUrl);
    await resetConsents(testDb.migrationUrl);
    await resetConfigState(testDb.migrationUrl);
  });

  async function seedPosition(userId: UserId, quantity: string): Promise<void> {
    await withTenant(
      userId,
      (tx) =>
        tx.insert(positions).values({
          id: PositionId.generate(),
          userId,
          assetId,
          institutionId: null,
          quantity: Quantity.fromString(quantity),
          averageCost: Money.fromString('20'),
          totalCost: Money.fromString('20').times(Quantity.fromString(quantity)),
          realizedGain: Money.zero(),
        }),
      seedDb,
    );
  }

  async function grantEmailConsent(userId: UserId): Promise<void> {
    await withTenant(
      userId,
      (tx) =>
        new DrizzleConsentRepository(tx, userId).upsert({
          id: ConsentId.generate(),
          userId,
          purpose: 'email_reminders',
          grantedAt: new Date('2026-01-01T00:00:00Z'),
          revokedAt: null,
          policyVersion: 'v1',
        }),
      seedDb,
    );
  }

  /**
   * Inserted directly rather than through `createRule`, so the rule already
   * carries a `lastState` of `hold` — as if a prior evaluation had already
   * established the baseline. That lets this file prove a real transition
   * (hold → buy) in a *single* `handleOpportunityEvaluate` call, which
   * matters for the reason `handlerPool` below explains: a second call
   * against the same pool would hit an unrelated, pre-existing defect this
   * test has no business tripping over.
   */
  async function seedRule(userId: UserId): Promise<OpportunityRule> {
    const rule: OpportunityRule = {
      id: OpportunityRuleId.generate(),
      userId,
      assetId,
      lower: { price: Money.fromString('30'), state: 'buy' },
      upper: { price: Money.fromString('45'), state: 'sell' },
      defaultState: 'hold',
      lastState: 'hold',
      lastEvaluatedAt: new Date('2026-03-16T13:00:00Z'),
      active: true,
      muted: false,
    };
    await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).insert(rule),
      seedDb,
    );
    return rule;
  }

  it('evaluates two tenants against the same polled asset, each against their own rule and consent, and only one sends', async () => {
    // userA: held, ruled (baseline: hold), consented — the quote below
    // crosses their lower bound to buy.
    await seedPosition(userA, '100');
    await grantEmailConsent(userA);
    await seedRule(userA);
    // userB: held and ruled identically, but never consented.
    await seedPosition(userB, '50');
    await seedRule(userB);

    // The price that will cross the lower bound for both tenants.
    await new DrizzleQuoteRepository(seedDb).upsertLatestQuote({
      assetId,
      price: Money.fromString('29'),
      quotedAt: new Date('2026-03-16T13:30:00Z'),
      fetchedAt: new Date('2026-03-16T13:30:00Z'),
      source: 'brapi_free',
    });

    const clock = new FakeClock('2026-03-16T13:30:00Z');
    const calendar = new FakeTradingCalendar(['2026-03-16']);
    calendar.sessionOpenOverride = true;

    /*
     * One notifier for the whole run, not one per tenant: delivery is the
     * handler's own step, performed after each tenant's transaction commits
     * (`worker/handlers/opportunity.ts`), so `sent[i].userId` is what says
     * which tenant a message was for. A per-tenant map would have hidden a
     * handler that sent every tenant's alert to the wrong one.
     */
    const notifier = new FakeOpportunityNotifier();

    /**
     * **Why this test opens a second, dedicated `Pool`/`Database` (`handlerPool`)
     * for the one call to `handleOpportunityEvaluate`, instead of reusing
     * `seedDb` like every other integration test in this suite does.**
     *
     * `handleOpportunityEvaluate` calls `resolveQuoteBudgetConfig`/`resolveConfig`
     * *bare* — no tenant context — to read `quotes.cadence_minutes` and
     * `notifications.quiet_hours` (both deployment-only settings). That code
     * path (`src/config/resolve.ts`'s `deploymentValue`/`primeDeploymentCache`)
     * has a confirmed, pre-existing defect, unrelated to SPEC-018 and reported
     * separately rather than fixed here: once a pooled Postgres connection has
     * run *any* `withTenant` transaction (`set_config('app.user_id', <uuid>,
     * true)`), that connection's `app.user_id` custom GUC is left "known but
     * empty" for the rest of its session — `current_setting('app.user_id',
     * true)` returns `''`, never `NULL`, from then on. `config_overrides`'s
     * `tenant_isolation` policy casts that setting to `uuid`
     * unconditionally — `'' :: uuid` — which Postgres raises 22P02 for, on
     * *every* later bare read against that table on that connection, **even
     * on an empty table** (confirmed by hand against this same database: a
     * `SELECT ... FROM config_overrides` with zero rows still raises once the
     * connection is tainted, because the RLS-injected qual is evaluated
     * independently of how many rows the scan produces). A *fresh* connection
     * that has never run `set_config` returns real `NULL`, and `NULL::uuid`
     * is simply `NULL` — no error.
     *
     * `seedDb` above is not fresh by the time this line runs: `seedPosition`/
     * `grantEmailConsent`/`seedRule` all called `withTenant` on it. Reusing it
     * here would make this test fail on a defect this feature does not own,
     * for a reason that has nothing to do with anything SPEC-018 changed —
     * worse, it would *pass* by coincidence whenever the connection pool
     * happened to hand back a connection nothing had used yet, which is
     * exactly the nondeterminism a shared pool guarantees eventually breaks.
     * A dedicated pool that has done nothing but this one call sidesteps it
     * cleanly and honestly, without disguising the underlying bug as fixed.
     *
     * This is also why this file makes exactly **one** call to
     * `handleOpportunityEvaluate`: its own per-tenant `withTenant` loop taints
     * `handlerPool` by the time it returns, so a second call on the same pool
     * would reproduce the identical failure this comment exists to avoid.
     */
    const handlerPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    const handlerDb = drizzle(handlerPool, { schema });

    function depsFor(
      tx: Parameters<Parameters<typeof handlerDb.transaction>[0]>[0],
      userId: UserId,
    ): OpportunityDependencies {
      return {
        rules: new DrizzleOpportunityRuleRepository(tx, userId),
        heldAssets: new DrizzleHeldAssetReader(tx, userId),
        quotes: new DrizzleStoredQuoteReader(handlerDb),
        catalog: new DrizzleAssetCatalogRepository(handlerDb),
        notificationLog: new DrizzleOpportunityNotificationLog(tx, userId),
        consents: new DrizzleConsentRepository(tx, userId),
        clock,
      };
    }

    try {
      await handleOpportunityEvaluate(
        { assetIds: [assetId] },
        { database: handlerDb, clock, calendar, depsFor, notifier },
      );
    } finally {
      await handlerPool.end();
    }

    // userA consented — exactly one email, addressed to userA.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.userId).toBe(userA);
    expect(notifier.sent[0]?.alert.state).toBe('buy');
    // userB never consented — the state still advances (BR-018-20), but no email.
    // Tenant B reached no sendable state, so nothing in the one shared inbox
    // above belongs to them.
    expect(notifier.sent.filter((entry) => entry.userId === userB)).toHaveLength(0);

    const ruleB = await withTenant(
      userB,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userB).findByAsset(assetId),
      seedDb,
    );
    expect(ruleB?.lastState).toBe('buy');
  });
});
