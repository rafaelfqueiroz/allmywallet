import { logger } from '@/lib/logger';
import { db as globalDb, type Database } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';
import { users } from '@/db/schema/users';
import { SystemClock, type Clock } from '@/core/shared/clock';
import { AssetId, UserId } from '@/core/shared/ids';
import { evaluateOpportunities } from '@/core/opportunity/run-evaluation';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import type { QuietHoursWindow } from '@/core/opportunity/notify';
import type { TradingCalendar } from '@/core/quotes/ports';
import { resolveConfig } from '@/config/resolve';
import { resolveQuoteBudgetConfig } from '@/worker/handlers/composition';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleOpportunityNotificationLog } from '@/adapters/db/opportunity-notification-repository';
import {
  DrizzleHeldAssetReader,
  DrizzleStoredQuoteReader,
} from '@/adapters/db/opportunity-read-adapters';
import { LogEmailSender } from '@/adapters/email/log-email-sender';

/**
 * SPEC-018 `opportunity.evaluate` — BR-018-11/DL-018-04. AR-04: a thin
 * entrypoint; every rule this job enforces lives in `core/opportunity/`.
 *
 * **The zero-added-provider-request rule is structural, not a promise kept by
 * this file's discipline.** `OpportunityDependencies` (`core/opportunity/
 * dependencies.ts`) carries no `QuoteProvider` port at all — only a
 * `StoredQuoteReader` over `latest_quotes`, the table SPEC-008 already
 * writes. Nothing built below, and nothing `evaluateOpportunities` is given,
 * is *capable* of making a network call; there is no fetch to accidentally
 * trigger. `tests/integration/opportunity-evaluation.test.ts` proves this
 * with a counting `QuoteProvider` fake that stays untouched across a full
 * evaluation cycle (AC-7); `tests/integration/opportunity-worker-handler.test.ts`
 * proves this file's own added behaviour — the tenant walk and the two config
 * reads — end to end.
 *
 * **Tenant handling** (ARCHITECTURE §5's worker caveat, identical to
 * `src/worker/handlers/valuation.ts#listTenantIds`). A background job has no
 * session, so `users` is read directly — the one deliberately cross-tenant
 * read, ids only — and every actual rule/position/consent read or write runs
 * inside a per-tenant `withTenant` transaction.
 */

export interface OpportunityEvaluateJobPayload {
  /** AR-21: ids, not objects — the assets that just received a new quote (`quotes.poll`'s `outcome === 'polled'` set). */
  readonly assetIds: readonly string[];
}

export interface OpportunityHandlerDeps {
  readonly database: Database;
  readonly clock: Clock;
  readonly calendar: TradingCalendar;
  /**
   * Built per tenant, inside `withTenant` — hence a factory, not an
   * instance, the same shape `ValuationHandlerDeps.snapshotsFor` uses. The
   * default builds the real, tenant-scoped `OpportunityDependencies`; an
   * integration test overrides this to inject a `FakeOpportunityNotifier`
   * (or any other fake) while still exercising the real tenant walk and the
   * two config reads below.
   */
  readonly depsFor: (tx: Tx, userId: UserId) => OpportunityDependencies;
}

function resolveDeps(overrides?: Partial<OpportunityHandlerDeps>): OpportunityHandlerDeps {
  const database = overrides?.database ?? globalDb;
  const clock = overrides?.clock ?? new SystemClock();
  const calendar = overrides?.calendar ?? new B3TradingCalendar();

  // Shared reference tables (AR-15) — one instance for the whole run, reused
  // across every tenant this pass walks. The notifier needs no tenant
  // context either: `OpportunityNotifier.sendStateChange` takes `userId` as
  // a call argument, not a constructor one.
  const quotes = new DrizzleStoredQuoteReader(database);
  const catalog = new DrizzleAssetCatalogRepository(database);
  const notifier = new LogEmailSender(clock);

  return {
    database,
    clock,
    calendar,
    depsFor:
      overrides?.depsFor ??
      ((tx, userId) => ({
        rules: new DrizzleOpportunityRuleRepository(tx, userId),
        heldAssets: new DrizzleHeldAssetReader(tx, userId),
        quotes,
        catalog,
        notificationLog: new DrizzleOpportunityNotificationLog(tx, userId),
        notifier,
        consents: new DrizzleConsentRepository(tx, userId),
        clock,
      })),
  };
}

/** Tenant ids only. The one cross-tenant read this job performs. */
async function listTenantIds(database: Database): Promise<readonly UserId[]> {
  const rows = await database.select({ id: users.id }).from(users);
  return rows.map((row) => UserId.of(row.id));
}

/**
 * SPEC-018 `opportunity.evaluate` — payload carries the assets that just
 * received a new quote (BR-018-11). Every tenant is walked because a quote is
 * shared (BR-018-25) and any tenant may hold a rule on any of these assets;
 * `evaluateOpportunities` itself is cheap to no-op for a tenant with no active
 * rule on any of `assetIds` (`run-evaluation.ts`'s own early return).
 */
export async function handleOpportunityEvaluate(
  payload: OpportunityEvaluateJobPayload,
  overrides?: Partial<OpportunityHandlerDeps>,
): Promise<void> {
  const { database, clock, calendar, depsFor } = resolveDeps(overrides);
  const assetIds = payload.assetIds.map((id) => AssetId.of(id));
  if (assetIds.length === 0) return;

  const now = clock.now();
  const sessionOpen = calendar.isSessionOpen(now);

  // BR-018-14: the same `quotes.cadence_minutes` SPEC-008 polls at — reading
  // a second, feature-local cadence would let this job disagree with the
  // screen about whether a quote is stale (BR-018-16).
  const { cadenceMinutes } = await resolveQuoteBudgetConfig(database);
  // BR-018-27: deployment-only (`src/config/registry.ts`), resolved once
  // outside the tenant loop rather than per user.
  const quietHours: QuietHoursWindow | null = (
    await resolveConfig('notifications.quiet_hours', { db: database })
  ).value;

  const tenantIds = await listTenantIds(database);

  let evaluated = 0;
  let sent = 0;
  let failures = 0;

  for (const userId of tenantIds) {
    try {
      const summary = await withTenant(
        userId,
        async (tx) => {
          // BR-018-22 — `notifications.opportunity_cooldown_hours` is
          // user-settable (`levels: ['deployment', 'user']`), so it is read
          // inside this tenant's own transaction (`ConfigOverrideOutsideTenantError`'s
          // doc comment in `src/config/resolve.ts` is exactly why: reading a
          // user-level override outside `withTenant` fails rather than
          // silently returning the deployment default).
          const cooldownHours = (
            await resolveConfig('notifications.opportunity_cooldown_hours', { db: tx, userId })
          ).value;

          return evaluateOpportunities(depsFor(tx, userId), userId, assetIds, {
            sessionOpen,
            cadenceMinutes,
            cooldownHours,
            quietHours,
          });
        },
        database,
      );
      evaluated += summary.evaluated;
      sent += summary.sent;
    } catch (error) {
      failures += 1;
      // AR-39/BR-004-04: the tenant id is a UUID, not personal data, and
      // nothing from a portfolio is logged.
      logger.error(
        { queue: 'opportunity.evaluate', userId, err: error },
        'opportunity.evaluate failed for tenant',
      );
    }
  }

  logger.info(
    { queue: 'opportunity.evaluate', assetCount: assetIds.length, evaluated, sent, failures },
    'opportunity.evaluate cycle complete',
  );
}
