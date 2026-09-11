import type { AssetClass } from '@/core/quotes/ports';
import type {
  AssetId,
  OpportunityNotificationId,
  OpportunityRuleId,
  UserId,
} from '@/core/shared/ids';
import type { Money, Quantity } from '@/core/shared/money';

/**
 * SPEC-018 — domain types and ports. AR-02/AR-03: declared here, next to the
 * use cases in this directory that need them; `src/adapters/db/` implements
 * the repository and log, `src/adapters/notifications/` implements the
 * notifier, `src/db/schema/opportunity.ts` is the storage shape they read and
 * write. Hand-written fakes in `test-support.ts` implement all of them for
 * use-case tests (TS-02).
 */

/** BR-018-06 — the three states a bound (or the default band) can carry. */
export const OPPORTUNITY_STATES = ['buy', 'hold', 'sell'] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/**
 * BR-018-16 — evaluation adds a fourth reading that no bound may ever carry:
 * a rule with no usable quote is `unknown`, never a state carried forward
 * from a price known to be old. Keeping it out of `OpportunityState` means a
 * bound's `state` field is structurally incapable of being "unknown" — a
 * user chooses buy, hold or sell, never "I don't know".
 */
export type EvaluatedState = OpportunityState | 'unknown';

/**
 * BR-018-05/06/10 — a threshold and the state it means to the user who set
 * it. The state lives on the bound, not on the rule, because DL-018-02
 * requires the *meaning* of a crossing to be chosen per bound: "below R$ 30"
 * is a buy for someone averaging down and a sell for someone running a
 * stop-loss, and one `OpportunityBound` shape has to express both.
 */
export interface OpportunityBound {
  readonly price: Money;
  readonly state: OpportunityState;
}

/**
 * One user's watch on one asset.
 *
 * BR-018-08: `lower` and `upper`, when both set, obey `lower.price <
 * upper.price` strictly — enforced in `rule.ts` at write time, not here, so
 * that an already-constructed `OpportunityRule` is always known-valid and no
 * reader has to re-check the invariant.
 */
export interface OpportunityRule {
  readonly id: OpportunityRuleId;
  readonly userId: UserId;
  readonly assetId: AssetId;
  readonly lower: OpportunityBound | null;
  readonly upper: OpportunityBound | null;
  /** BR-018-07 — the state between the bounds. Defaults to `hold` at creation. */
  readonly defaultState: OpportunityState;
  /** BR-018-13 — the last state a stored quote produced, or `null` before the first evaluation. */
  readonly lastState: OpportunityState | null;
  readonly lastEvaluatedAt: Date | null;
  /** BR-018-03 — false while the position that justified this rule is at zero. */
  readonly active: boolean;
  /** BR-018-26 — per-asset mute. Suppresses email only; the rule keeps evaluating. */
  readonly muted: boolean;
}

export interface OpportunityRuleRepository {
  findByAsset(assetId: AssetId): Promise<OpportunityRule | null>;
  listAll(): Promise<readonly OpportunityRule[]>;
  listActiveForAssets(assetIds: readonly AssetId[]): Promise<readonly OpportunityRule[]>;
  insert(rule: OpportunityRule): Promise<void>;
  update(rule: OpportunityRule): Promise<void>;
  /** BR-018-03 — rules are retained, never deleted by a sale; this is only ever a user-initiated delete. */
  delete(id: OpportunityRuleId): Promise<void>;
  /** BR-018-13 — persists the evaluated state and the instant it was observed. */
  recordObservation(id: OpportunityRuleId, state: OpportunityState, at: Date): Promise<void>;
  /** BR-018-03 — batched activate/deactivate, driven by `reconcileActivation`. */
  setActive(ids: readonly OpportunityRuleId[], active: boolean): Promise<void>;
}

/**
 * BR-018-24/DL-018-08 — the record that makes a send idempotent against the
 * specific observation that triggered it, independent of the `lastState`
 * column above.
 *
 * The two exist for different failure modes. `lastState` is what the in-app
 * screen reads and what tells a change from a repeat (BR-018-13); it must be
 * updated even when no email is due (muted, not consented, cooldown, quiet
 * hours) so the screen is always current per BR-018-20. This log is what
 * stops **the email** from being duplicated when pg-boss retries a handler
 * that crashed after sending but before the job could be marked complete
 * (AR-19 — delivery is at-least-once). Relying on `lastState` alone cannot
 * cover that: by the time a retry runs, `lastState` may already equal the
 * new state (if it was written before the crash) or may not (if the crash
 * came earlier), and neither case is safe to infer a send from.
 */
export interface OpportunityNotificationLog {
  /**
   * Insert-if-absent on `(ruleId, state, quoteObservedAt)`, returning whether
   * **this call** was the one that wrote the row: `INSERT … ON CONFLICT DO
   * NOTHING RETURNING id`, and `false` when the `RETURNING` set came back
   * empty because another attempt already claimed it.
   *
   * Idempotency lives in the write, not in a caller that remembers to look
   * first — the same reasoning `WalletGoalRepository.markAchieved` applies to
   * `achieved_on IS NULL`.
   */
  claim(entry: {
    readonly id: OpportunityNotificationId;
    readonly userId: UserId;
    readonly ruleId: OpportunityRuleId;
    readonly state: OpportunityState;
    /** The quote's own `quotedAt`, not the instant this job runs — see `run-evaluation.ts`. */
    readonly quoteObservedAt: Date;
    readonly sentAt: Date;
  }): Promise<boolean>;
  /** BR-018-20/22 — the last send for this rule, or `null` if none has ever gone out. */
  lastSentAt(ruleId: OpportunityRuleId): Promise<Date | null>;
  /** Batched form of the above, for evaluating many rules in one pass. */
  lastSentAtByRule(
    ruleIds: readonly OpportunityRuleId[],
  ): Promise<ReadonlyMap<OpportunityRuleId, Date>>;
}

/**
 * BR-018-28/DL-018-07 — the one thing an adapter renders into an email.
 *
 * No email address: the port takes a `UserId` below and the adapter resolves
 * the address, so the domain never handles one (AR-39, BR-004-04). No
 * position size, no portfolio value, no CPF: every field here is either
 * public market data (the asset, its price) or the user's own rule (the
 * threshold, the state it produced) — nothing this type could carry would
 * violate BR-018-28 even if an adapter rendered every field it has.
 */
export interface OpportunityAlert {
  readonly assetCode: string;
  readonly assetName: string;
  readonly price: Money;
  readonly quotedAt: Date;
  readonly source: string;
  readonly state: OpportunityState;
  readonly matched: 'lower' | 'upper' | 'default';
  /** `null` when the default band matched — there is no single threshold to name. */
  readonly threshold: Money | null;
  /**
   * BR-018-15 — the polling cadence the disclosure in the message quotes, in
   * minutes. Carried on the alert rather than read by the adapter because it
   * is `quotes.cadence_minutes`, which SPEC-008 BR-008-22 **degrades at
   * runtime** under budget pressure: an adapter that hardcoded 30, or read the
   * key a second time, could tell a reader a different delay than the screen
   * that showed them the same state. This is the number the evaluation
   * actually used to decide the quote was fresh enough to act on.
   */
  readonly delayMinutes: number;
}

export interface OpportunityNotifier {
  sendStateChange(userId: UserId, alert: OpportunityAlert): Promise<void>;
}

/**
 * How often the price behind a quote is republished, which is what decides
 * whether it can be *stale* at all (BR-018-16's "beyond its tier").
 *
 * `intraday` is SPEC-008's polled quote (`latest_quotes`): republished every
 * `quotes.cadence_minutes` while the B3 session is open, so one older than
 * that interval is genuinely behind and the state reads `unknown`.
 *
 * `daily` is a published close (`price_quotes`) — the only price Tesouro
 * Direto has, since `derivePollingSet` deliberately never polls it
 * (SPEC-008 BR-008-11) and `tesouro.sync` writes closes rather than quotes.
 * It is not carried forward *by this feature*: it is the price the rest of
 * the product already shows for that title, because `core/valuation`'s
 * `valueTesouro` values the position from exactly this row and flags nothing
 * for its age (BR-009-03's carry-forward). Applying a minutes-based cadence
 * to it would mark every Tesouro holding `unknown` from the first minute of
 * every session — a state disagreeing with the price *Patrimônio* is showing
 * the same user on the same screen refresh, which BR-018-14 exists to
 * prevent.
 */
export type QuoteTier = 'intraday' | 'daily';

export interface StoredQuote {
  readonly price: Money;
  readonly quotedAt: Date;
  readonly fetchedAt: Date;
  readonly source: string;
  readonly tier: QuoteTier;
}

/**
 * BR-018-11/14 — already-stored quotes only, read from the same table SPEC-008
 * writes and every other screen displays.
 *
 * **There is deliberately no `QuoteProvider` port anywhere in this file or in
 * `dependencies.ts`.** That is not an oversight to fill in later — it is how
 * "evaluating rules issues zero provider requests" (an acceptance criterion)
 * is enforced structurally rather than merely asserted in a test: `core/
 * opportunity` is physically incapable of making a provider call, because
 * nothing in its dependency graph can reach one. A future change that wanted
 * opportunity evaluation to fetch a quote would have to add a port here for
 * anyone to notice the constraint was being lifted.
 */
export interface StoredQuoteReader {
  latestFor(assetIds: readonly AssetId[]): Promise<ReadonlyMap<AssetId, StoredQuote>>;
}

/** One asset the user currently holds, and the class that decides BR-018-02 eligibility. */
export interface HeldAssetReader {
  listHeld(): Promise<readonly { assetId: AssetId; assetClass: AssetClass; quantity: Quantity }[]>;
}
