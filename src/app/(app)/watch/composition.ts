import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleConsentRepository } from '@/adapters/db/consent-repository';
import { DrizzleOpportunityRuleRepository } from '@/adapters/db/opportunity-rule-repository';
import { DrizzleOpportunityNotificationLog } from '@/adapters/db/opportunity-notification-repository';
import {
  DrizzleHeldAssetReader,
  DrizzleStoredQuoteReader,
} from '@/adapters/db/opportunity-read-adapters';
import { db } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-018 — the composition root for `/watch` (AR-02), in the shape of
 * `src/app/(app)/wallets/composition.ts`: the one place that wires
 * `core/opportunity`'s ports to their Drizzle adapters for this route's
 * Server Components and server actions.
 *
 * **No notifier**, and no stub standing in for one either:
 * `OpportunityDependencies` carries no `OpportunityNotifier` at all (see its
 * own doc comment for why an email must not be sendable from inside a tenant
 * transaction). This surface reads rules and writes rules. The single place a
 * message is delivered is `worker/handlers/opportunity.ts`, after its
 * transaction has committed.
 */
const clock = new SystemClock();

export function buildWatchDeps(tx: Tx, userId: UserId): OpportunityDependencies {
  return {
    rules: new DrizzleOpportunityRuleRepository(tx, userId),
    heldAssets: new DrizzleHeldAssetReader(tx, userId),
    // AR-15/deadlock avoidance, exactly as for `catalog` below: `latest_quotes`
    // and `price_quotes` carry no tenant column, so reading them on the
    // transaction this request already holds is free — and taking a *second*
    // pooled connection from inside an open transaction is how ten concurrent
    // renders of `/reports/composition` deadlock a `max: 10` pool.
    quotes: new DrizzleStoredQuoteReader(tx),
    // AR-15/deadlock avoidance: the transaction already open for this
    // request, not a second pooled connection — the same reasoning
    // `wallets/composition.ts#buildWalletDeps` gives for `assetCatalog`.
    catalog: new DrizzleAssetCatalogRepository(tx),
    notificationLog: new DrizzleOpportunityNotificationLog(tx, userId),
    // SPEC-004's own repository, not a feature-local copy — see
    // `core/opportunity/dependencies.ts`'s own comment on why a second
    // consent store is the one thing LGPD compliance cannot survive.
    consents: new DrizzleConsentRepository(tx, userId),
    clock,
  };
}

export async function withWatchDeps<T>(
  userId: UserId,
  fn: (deps: OpportunityDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildWatchDeps(tx, userId)), db);
}
