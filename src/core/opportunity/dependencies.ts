import type { Clock } from '@/core/shared/clock';
import type { ConsentRepository } from '@/core/privacy/ports';
import type { AssetCatalogPort } from '@/core/quotes/ports';
import type {
  HeldAssetReader,
  OpportunityNotificationLog,
  OpportunityRuleRepository,
  StoredQuoteReader,
} from '@/core/opportunity/ports';

/**
 * SPEC-018 — what every opportunity use case needs, injected at the
 * composition root (AR-02).
 *
 * `consents` is SPEC-004's repository, not a feature-local copy — the same
 * choice `core/goals/dependencies.ts` makes for the identical reason.
 * BR-018-25's opt-in *is* the `email_reminders` purpose (`CONSENT_PURPOSES`),
 * and a second consent store would be a second place a user's decision could
 * be recorded, which LGPD compliance cannot survive.
 *
 * `catalog` is SPEC-008's `AssetCatalogPort`, not a new opportunity-local
 * read port. `run-evaluation.ts` needs an asset's code and name to build the
 * `OpportunityAlert` an email is rendered from (BR-018-28), and
 * `AssetCatalogPort.findByIds` already answers exactly that question — it is
 * the same table every other screen reads. Declaring a second port for a
 * query that already exists would be a port where there is no seam (AR-03),
 * and would risk this feature's alert disagreeing with the catalog's own
 * name for an asset.
 *
 * **There is deliberately no `QuoteProvider` port here — not even
 * unused.** BR-018-11 requires evaluation to add zero requests to SPEC-008's
 * quote budget, and the only way to make that a structural guarantee rather
 * than a promise kept by discipline is for nothing in this dependency bundle
 * to be capable of fetching a quote. `quotes: StoredQuoteReader` below reads
 * only what SPEC-008 has already written; see its own doc comment in
 * `ports.ts` for the acceptance criterion this satisfies.
 *
 * **There is no `OpportunityNotifier` here either, and for a related
 * reason.** Every port above is backed by an adapter bound to one tenant
 * transaction (AR-11), and sending an email is not something a transaction
 * can undo. `evaluateOpportunities` therefore returns the alerts it claimed
 * and the *caller* delivers them once that transaction has committed — see
 * its own doc comment. Handing this bundle a notifier would put the single
 * irreversible step of the feature inside the one place that can still roll
 * back, which is how a rolled-back pass turns into a duplicate email on the
 * next poll.
 */
export interface OpportunityDependencies {
  readonly rules: OpportunityRuleRepository;
  readonly heldAssets: HeldAssetReader;
  readonly quotes: StoredQuoteReader;
  readonly catalog: AssetCatalogPort;
  readonly notificationLog: OpportunityNotificationLog;
  readonly consents: ConsentRepository;
  readonly clock: Clock;
}
