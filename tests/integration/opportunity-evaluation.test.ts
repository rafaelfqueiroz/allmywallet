import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { positions } from '@/db/schema/positions';
import { withTenant, type Tx } from '@/db/tenant';
import { FakeClock } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { ConsentId, PositionId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { isErr, isOk } from '@/core/shared/result';
import { evaluateOpportunities } from '@/core/opportunity/run-evaluation';
import type { EvaluateOpportunitiesOptions } from '@/core/opportunity/run-evaluation';
import { createRule } from '@/core/opportunity/rule';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import { OpportunityErrorCode } from '@/core/opportunity/errors';
import { FakeOpportunityNotifier } from '@/core/opportunity/test-support';
import { FakeQuoteProvider } from '@/core/quotes/test-support';
import { revokeConsent } from '@/core/privacy/consent';
import type { PrivacyDependencies } from '@/core/privacy/dependencies';
import {
  FakeAccountDeletionPort,
  FakeAuditLogPort,
  FakeNotificationPort,
  FakePersonalDataExportPort,
} from '@/core/privacy/test-support/fake-repositories';
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
import { resetLedger, resetOpportunity, resetUsers, resetConsents } from '../support/reset';
import { seedUser } from '../support/users';
import { seedAsset, type SeededAsset } from '../support/ledger-fixtures';

/**
 * SPEC-018 — `evaluateOpportunities` wired to every real adapter (rule repo,
 * notification log, held-asset reader over `positions`, stored-quote reader
 * over `latest_quotes`, asset catalog, consent repository) against real
 * Postgres. The notifier is a hand-written fake (TS-02) — asserting a real
 * send happened is `core/opportunity`'s own job (`run-evaluation.test.ts`);
 * this file's job is proving the *wiring* — that a real DB round trip
 * produces the exact same behaviour the unit tests already proved in the
 * abstract.
 *
 * DEVIATION from the issue's Test plan, noted for the Decision log: these
 * scenarios call `evaluateOpportunities` directly rather than through
 * `handleOpportunityEvaluate` (the worker handler). The handler's only added
 * behaviour is the cross-tenant `users` walk and resolving two config keys —
 * both are either exercised by `tests/integration/quotes-handlers.test.ts`
 * (the enqueue seam) or too thin to be worth re-proving per scenario here.
 *
 * TS-03/TS-33: truncates in both `beforeAll` and `afterAll`.
 */
describe('SPEC-018 — evaluateOpportunities (integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let stock: SeededAsset;

  async function cleanup(): Promise<void> {
    await resetOpportunity(testDb.migrationUrl);
    await resetConsents(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await cleanup();
    await seedUser(testDb.migrationUrl, userId);
    stock = await seedAsset(testDb.migrationUrl, 'PETR4', 'Petrobras PN');

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
    await resetConsents(testDb.migrationUrl);
  });

  async function seedPosition(assetId: AssetId, quantity: string): Promise<void> {
    const zero = quantity === '0';
    await withTenant(
      userId,
      (tx) =>
        tx
          .insert(positions)
          .values({
            id: PositionId.generate(),
            userId,
            assetId,
            institutionId: null,
            quantity: Quantity.fromString(quantity),
            averageCost: zero ? Money.zero() : Money.fromString('20'),
            totalCost: zero
              ? Money.zero()
              : Money.fromString('20').times(Quantity.fromString(quantity)),
            realizedGain: Money.zero(),
          })
          .onConflictDoUpdate({
            target: [positions.userId, positions.assetId, positions.institutionId],
            set: {
              quantity: Quantity.fromString(quantity),
              averageCost: zero ? Money.zero() : Money.fromString('20'),
              totalCost: zero
                ? Money.zero()
                : Money.fromString('20').times(Quantity.fromString(quantity)),
              updatedAt: new Date(),
            },
          }),
      db,
    );
  }

  async function grantEmailConsent(): Promise<void> {
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
      db,
    );
  }

  function depsFor(
    tx: Tx,
    notifier: FakeOpportunityNotifier,
    clock: FakeClock,
  ): OpportunityDependencies {
    return {
      rules: new DrizzleOpportunityRuleRepository(tx, userId),
      heldAssets: new DrizzleHeldAssetReader(tx, userId),
      quotes: new DrizzleStoredQuoteReader(db),
      catalog: new DrizzleAssetCatalogRepository(db),
      notificationLog: new DrizzleOpportunityNotificationLog(tx, userId),
      notifier,
      consents: new DrizzleConsentRepository(tx, userId),
      clock,
    };
  }

  async function setQuote(assetId: AssetId, price: string, fetchedAt: Date): Promise<void> {
    await new DrizzleQuoteRepository(db).upsertLatestQuote({
      assetId,
      price: Money.fromString(price),
      quotedAt: fetchedAt,
      fetchedAt,
      source: 'brapi_free',
    });
  }

  const OPTIONS: EvaluateOpportunitiesOptions = {
    sessionOpen: true,
    cadenceMinutes: 30,
    cooldownHours: 24,
    quietHours: null,
  };

  it('AC-7: issues zero provider requests across a full evaluation cycle', async () => {
    await seedPosition(stock.id, '100');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    await setQuote(stock.id, '35', clock.now());

    const notifier = new FakeOpportunityNotifier();
    // Present in the test's scope, never wired into `OpportunityDependencies`
    // — there is no port for it to be wired into (`dependencies.ts`'s own
    // doc comment). Its count staying at zero after a full pass is the
    // acceptance criterion's own wording: "assert the count is unchanged".
    const provider = new FakeQuoteProvider();

    await withTenant(
      userId,
      async (tx) => {
        const created = await createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
        });
        expect(isOk(created)).toBe(true);
        await evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS);
      },
      db,
    );

    expect(provider.callCount).toBe(0);
  });

  it('AC-11/AC-13: a state change with consent sends exactly one email; re-running over the same quote sends none', async () => {
    await seedPosition(stock.id, '100');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
          upper: { price: Money.fromString('45'), state: 'sell' },
        }),
      db,
    );

    // Pass 1 — baseline inside the band (hold). No email: BR-018-21 needs a
    // *change*, and a rule's first evaluation has nothing to differ from.
    await setQuote(stock.id, '35', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(0);

    // Pass 2 — the price crosses the lower bound. A real, sendable transition.
    clock.set('2026-03-16T13:30:00Z');
    await setQuote(stock.id, '29', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.alert.state).toBe('buy');

    // Pass 3 — same quote evaluated again (a pg-boss-style retry over an
    // observation the state has already caught up to). No new state to
    // report, so no second email.
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(1);
  });

  it('AC-12: a second state change inside the cooldown window sends nothing, while the persisted state still advances', async () => {
    await seedPosition(stock.id, '100');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
          upper: { price: Money.fromString('45'), state: 'sell' },
        }),
      db,
    );

    await setQuote(stock.id, '35', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    // First real crossing — sends and starts the cooldown clock.
    clock.set('2026-03-16T13:30:00Z');
    await setQuote(stock.id, '29', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(1);

    // A second, genuine crossing three hours later — well inside the 24h
    // cooldown (DL-018-05's accepted cost: a real second crossing is
    // suppressed exactly as a false one would be).
    clock.set('2026-03-16T16:30:00Z');
    await setQuote(stock.id, '46', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(1); // still just the one email

    // But the in-app state is current (BR-018-20) — the suppression is
    // visible, not silent.
    const found = await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).findByAsset(stock.id),
      db,
    );
    expect(found?.lastState).toBe('sell');
  });

  it('AC-14: a user who has not consented gets no email, and the in-app state still advances', async () => {
    await seedPosition(stock.id, '100');
    // Deliberately no `grantEmailConsent()` call.
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
        }),
      db,
    );

    await setQuote(stock.id, '35', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    clock.set('2026-03-16T13:30:00Z');
    await setQuote(stock.id, '29', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    expect(notifier.sent).toHaveLength(0);
    const found = await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).findByAsset(stock.id),
      db,
    );
    expect(found?.lastState).toBe('buy'); // the in-app read path is fully current regardless
  });

  it('AC-16: a stale quote yields the unknown state and sends nothing', async () => {
    await seedPosition(stock.id, '100');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
        }),
      db,
    );

    // Fetched 45 minutes before "now", with a 30-minute cadence and the
    // session open — `isQuoteStale` reads this as stale.
    await setQuote(stock.id, '29', new Date('2026-03-16T12:15:00Z'));
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    expect(notifier.sent).toHaveLength(0);
    const found = await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).findByAsset(stock.id),
      db,
    );
    // BR-018-16: an unknown reading is never persisted as a state — it stays
    // at whatever it was before (never evaluated, here).
    expect(found?.lastState).toBeNull();
  });

  it('AC-2: a CDB is rejected server-side by createRule, not merely hidden in a UI', async () => {
    const cdb = await seedAsset(testDb.migrationUrl, 'CDB-TESTE', 'CDB Banco Teste', 'cdb');
    await seedPosition(cdb.id, '1000');
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    const result = await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: cdb.id,
          lower: { price: Money.fromString('100'), state: 'sell' },
        }),
      db,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(OpportunityErrorCode.ASSET_CLASS_NOT_WATCHABLE);
    }
  });

  it('AC-3: selling a position to zero deactivates its rule without deleting it; rebuying reactivates it with the same thresholds', async () => {
    await seedPosition(stock.id, '10');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    const created = await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
          upper: { price: Money.fromString('45'), state: 'sell' },
        }),
      db,
    );
    expect(isOk(created)).toBe(true);

    // Sell to zero.
    await seedPosition(stock.id, '0');
    await setQuote(stock.id, '35', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    const afterSale = await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).findByAsset(stock.id),
      db,
    );
    expect(afterSale?.active).toBe(false);
    expect(afterSale?.lower?.price.toString()).toBe('30'); // retained, not deleted

    // Rebuy.
    await seedPosition(stock.id, '10');
    clock.set('2026-03-16T13:30:00Z');
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    const afterRebuy = await withTenant(
      userId,
      (tx) => new DrizzleOpportunityRuleRepository(tx, userId).findByAsset(stock.id),
      db,
    );
    expect(afterRebuy?.active).toBe(true);
    expect(afterRebuy?.lower?.price.toString()).toBe('30');
    expect(afterRebuy?.upper?.price.toString()).toBe('45');
  });

  it('AC-15: unsubscribing (revoking email_reminders) stops all further opportunity email, with no session', async () => {
    await seedPosition(stock.id, '100');
    await grantEmailConsent();
    const clock = new FakeClock('2026-03-16T13:00:00Z');
    const notifier = new FakeOpportunityNotifier();

    await withTenant(
      userId,
      (tx) =>
        createRule(depsFor(tx, notifier, clock), userId, {
          assetId: stock.id,
          lower: { price: Money.fromString('30'), state: 'buy' },
          upper: { price: Money.fromString('45'), state: 'sell' },
        }),
      db,
    );

    await setQuote(stock.id, '35', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    clock.set('2026-03-16T13:30:00Z');
    await setQuote(stock.id, '29', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );
    expect(notifier.sent).toHaveLength(1);

    // The exact call `confirmUnsubscribeAction` makes once the token verifies
    // — no `requireUserId()`/session anywhere in this path (AR-12's
    // documented exception, `src/app/unsubscribe/actions.ts`).
    await withTenant(
      userId,
      (tx) => {
        const deps: PrivacyDependencies = {
          consents: new DrizzleConsentRepository(tx, userId),
          auditLog: new FakeAuditLogPort(),
          exportData: new FakePersonalDataExportPort(),
          accountDeletion: new FakeAccountDeletionPort(),
          notifications: new FakeNotificationPort(),
          clock,
        };
        return revokeConsent(deps, userId, 'email_reminders');
      },
      db,
    );

    // Well outside the cooldown, and a genuinely different state — if
    // consent still gated correctly this would otherwise send.
    clock.set('2026-03-18T13:00:00Z');
    await setQuote(stock.id, '46', clock.now());
    await withTenant(
      userId,
      (tx) => evaluateOpportunities(depsFor(tx, notifier, clock), userId, [stock.id], OPTIONS),
      db,
    );

    expect(notifier.sent).toHaveLength(1); // unchanged — no email since the revoke
  });
});
