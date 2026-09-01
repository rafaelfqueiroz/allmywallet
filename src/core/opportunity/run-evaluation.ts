import { OpportunityNotificationId } from '@/core/shared/ids';
import type { AssetId, UserId } from '@/core/shared/ids';
import type { OpportunityDependencies } from '@/core/opportunity/dependencies';
import { evaluateRule } from '@/core/opportunity/evaluate';
import { decideNotification } from '@/core/opportunity/notify';
import type { QuietHoursWindow } from '@/core/opportunity/notify';
import { reconcileActivation } from '@/core/opportunity/rule';
import type { OpportunityAlert } from '@/core/opportunity/ports';

/**
 * SPEC-018 — the use case `worker/handlers/opportunity.ts` (owned by another
 * agent) calls when SPEC-008 writes a new quote (BR-018-11/DL-018-04): never
 * on a schedule of its own, always in response to a quote already stored.
 */

export interface EvaluateOpportunitiesOptions {
  /** Whether the B3 session is open right now — `isQuoteStale`'s first argument. */
  readonly sessionOpen: boolean;
  readonly cadenceMinutes: number;
  /** `notifications.opportunity_cooldown_hours` (SPEC-002), resolved by the caller — see `dependencies.ts`. */
  readonly cooldownHours: number;
  /** `notifications.quiet_hours` (SPEC-002), resolved by the caller. */
  readonly quietHours: QuietHoursWindow | null;
}

export interface EvaluationSummary {
  readonly evaluated: number;
  /** Rules whose evaluated state is a real, different state from their previously persisted one. */
  readonly changed: number;
  /**
   * Changes this pass **claimed** in the notification log, and therefore owes
   * an email for. Not "sent" — see `alerts` below, and this function's own
   * doc comment for why the send is not this function's to perform.
   */
  readonly claimed: number;
  /** A real change (see `changed`) that produced no email for a BR-018-25/26/27 policy reason. */
  readonly suppressed: number;
  /**
   * The messages this pass claimed, for the caller to deliver **after** the
   * transaction this ran in has committed. One entry per `claimed`.
   */
  readonly alerts: readonly OpportunityAlert[];
}

const EMPTY_SUMMARY: EvaluationSummary = {
  evaluated: 0,
  changed: 0,
  claimed: 0,
  suppressed: 0,
  alerts: [],
};

/**
 * One evaluation pass over a set of assets that just received a quote.
 *
 * **Idempotent under pg-boss retry (AR-19).** Running this twice over the
 * same stored quote claims exactly one email: `OpportunityNotificationLog
 * .claim` is keyed on `(ruleId, state, quote.quotedAt)`, so a retried call
 * recomputes the identical key, finds it already claimed, and returns no
 * alert for it — see `ports.ts` and DL-018-08.
 *
 * **This function does not send anything, and that is the whole point.** It
 * returns the alerts it claimed and leaves delivery to the caller, because
 * every write above runs inside one tenant transaction (`withTenant`,
 * AR-11) and an email is not transactional. Sending from in here would put
 * an unrecoverable side effect inside something that can still roll back:
 * one rule's send failing would discard the *previous* rule's committed
 * claim along with the whole pass's `lastState` advances, and the next poll
 * would then re-evaluate against the stale prior state, find a fresh
 * `quotedAt`, claim a new key and send the same crossing twice — precisely
 * the duplicate DL-018-08 exists to prevent. It would also hold a pooled
 * connection and the transaction's locks open across an SMTP round trip.
 *
 * So the ordering that matters is the caller's: commit, then send. That
 * makes delivery at-most-once — a crash between the commit and the send
 * loses one message, and the log's committed claim means it is never
 * re-sent. That is the direction DL-018-08 chooses deliberately: the spec's
 * acceptance criteria ask for "exactly one email" and "no duplicate on
 * re-run", and a duplicate reaching an inbox is the failure it names.
 */
export async function evaluateOpportunities(
  deps: OpportunityDependencies,
  userId: UserId,
  assetIds: readonly AssetId[],
  options: EvaluateOpportunitiesOptions,
): Promise<EvaluationSummary> {
  if (assetIds.length === 0) return EMPTY_SUMMARY;

  // BR-018-03 — recomputed from current holdings every time rules are read,
  // rather than hooked into the transaction-write path. Cheap: this is a
  // full read of the user's rules and holdings, not a per-asset query.
  const [held, allRules] = await Promise.all([deps.heldAssets.listHeld(), deps.rules.listAll()]);
  const heldAssetIds = new Set(
    held.filter((row) => !row.quantity.isZero()).map((row) => row.assetId),
  );
  const { activate, deactivate } = reconcileActivation(allRules, heldAssetIds);
  if (activate.length > 0) await deps.rules.setActive(activate, true);
  if (deactivate.length > 0) await deps.rules.setActive(deactivate, false);

  const rules = await deps.rules.listActiveForAssets(assetIds);
  if (rules.length === 0) return EMPTY_SUMMARY;

  const now = deps.clock.now();
  const ruleAssetIds = rules.map((rule) => rule.assetId);
  const ruleIds = rules.map((rule) => rule.id);

  const [quotesByAsset, lastSentByRule, assets, consent] = await Promise.all([
    deps.quotes.latestFor(ruleAssetIds),
    deps.notificationLog.lastSentAtByRule(ruleIds),
    deps.catalog.findByIds(ruleAssetIds),
    deps.consents.findByPurpose(userId, 'email_reminders'),
  ]);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  // BR-018-25 — a single opt-in check for the whole pass; every rule belongs
  // to the same `userId` (AR-11 scopes `listActiveForAssets` to the caller's
  // tenant), so consent cannot differ rule to rule.
  const consented = consent !== null && consent.grantedAt !== null && consent.revokedAt === null;

  let changed = 0;
  let suppressed = 0;
  const alerts: OpportunityAlert[] = [];

  for (const rule of rules) {
    const quote = quotesByAsset.get(rule.assetId) ?? null;
    const result = evaluateRule(rule, quote, {
      sessionOpen: options.sessionOpen,
      cadenceMinutes: options.cadenceMinutes,
      now,
    });

    // BR-018-16 — an unknown reading has nothing to persist, decide or send:
    // it must not overwrite `lastState` with a guess, and it can never be a
    // "state changed" observation because there is no state to compare. This
    // single check is also what narrows `result` to the branch carrying
    // `matched`/`threshold`/`quote` for the rest of this iteration.
    if (result.state === 'unknown') continue;

    const isRealTransition = rule.lastState !== null && result.state !== rule.lastState;
    if (isRealTransition) changed += 1;

    const decision = decideNotification({
      active: rule.active,
      muted: rule.muted,
      consented,
      lastState: rule.lastState,
      evaluatedState: result.state,
      lastSentAt: lastSentByRule.get(rule.id) ?? null,
      now,
      cooldownHours: options.cooldownHours,
      quietHours: options.quietHours,
    });

    if (decision.send) {
      const asset = assetsById.get(rule.assetId);
      // Defensive: every asset behind an active rule was proven held (and
      // therefore catalogued) at creation time and again by this pass's own
      // `reconcileActivation`. A miss here would mean the catalog and the
      // holdings/rules tables have drifted apart, which this function cannot
      // fix — it skips the send rather than building an alert with no name
      // to put in it.
      if (asset !== undefined) {
        const claimed = await deps.notificationLog.claim({
          id: OpportunityNotificationId.generate(),
          userId,
          ruleId: rule.id,
          state: result.state,
          quoteObservedAt: result.quote.quotedAt,
          sentAt: now,
        });
        if (claimed) {
          alerts.push({
            assetCode: asset.code,
            assetName: asset.name,
            price: result.quote.price,
            quotedAt: result.quote.quotedAt,
            source: result.quote.source,
            state: result.state,
            matched: result.matched,
            threshold: result.threshold,
            delayMinutes: options.cadenceMinutes,
          });
        }
      }
    } else if (
      decision.reason === 'muted' ||
      decision.reason === 'not_consented' ||
      decision.reason === 'cooldown' ||
      decision.reason === 'quiet_hours'
    ) {
      suppressed += 1;
    }

    // BR-018-13 — persist whenever a real state was read, whether or not it
    // changed, so `lastEvaluatedAt` always reflects the last time a usable
    // quote was actually evaluated.
    //
    // Ordered after the claim above, not before, so a failure while claiming
    // leaves `lastState` untouched: the retry then recomputes the same
    // `state_changed` decision from the same prior state, rather than reading
    // the new state back and concluding that nothing changed and no email is
    // owed.
    await deps.rules.recordObservation(rule.id, result.state, now);
  }

  return { evaluated: rules.length, changed, claimed: alerts.length, suppressed, alerts };
}
