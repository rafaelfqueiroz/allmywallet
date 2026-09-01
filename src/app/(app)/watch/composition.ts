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
import { LogEmailSender } from '@/adapters/email/log-email-sender';
import { db } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * SPEC-018 — the composition root for `/watch` (AR-02), in the shape of
 * `src/app/(app)/wallets/composition.ts`: the one place that wires
 * `core/opportunity`'s ports to their Drizzle adapters for this route's
 * Server Components and server actions.
 *
 * `notifier` is wired to the real (interim) `LogEmailSender` rather than a
 * throwing stub, unlike `goals-composition.ts`'s `UnusedWalletValuationPort`.
 * The difference: that stub exists because a *generic* pricer cannot be built
 * without a wallet in scope yet (a real data dependency is missing), whereas
 * `LogEmailSender` needs nothing this composition root does not already have
 * (`clock`) and is exactly the adapter the worker wires for the same port —
 * using it here costs nothing and keeps one fewer stub class in the tree.
 * `createRule`/`updateRule` (`core/opportunity/rule.ts`) never call
 * `notifier.sendStateChange` — only `run-evaluation.ts`'s worker path does —
 * so it is, in practice, as inert here as the goals stub is on its own route.
 */
const clock = new SystemClock();

export function buildWatchDeps(tx: Tx, userId: UserId): OpportunityDependencies {
  return {
    rules: new DrizzleOpportunityRuleRepository(tx, userId),
    heldAssets: new DrizzleHeldAssetReader(tx, userId),
    // `latest_quotes` has no tenant column (AR-15) but `DrizzleStoredQuoteReader`
    // is typed against the pooled `Database`, not `Tx` — matching how
    // `worker/handlers/opportunity.ts#resolveDeps` builds the same class.
    quotes: new DrizzleStoredQuoteReader(db),
    // AR-15/deadlock avoidance: the transaction already open for this
    // request, not a second pooled connection — the same reasoning
    // `wallets/composition.ts#buildWalletDeps` gives for `assetCatalog`.
    catalog: new DrizzleAssetCatalogRepository(tx),
    notificationLog: new DrizzleOpportunityNotificationLog(tx, userId),
    notifier: new LogEmailSender(clock),
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
