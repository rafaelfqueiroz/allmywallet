import { boolean, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money } from '@/db/numeric';
import { assets } from '@/db/schema/assets';
import { users } from '@/db/schema/users';

/**
 * SPEC-018 (#90) — the buy/sell opportunity watch.
 *
 * Both tables are tenant-scoped (AR-14): `user_id`, ENABLE + FORCE row level
 * security, and a `USING`/`WITH CHECK` policy ship in the same migration
 * that creates them (`0015_opportunity.sql`).
 *
 * `OPPORTUNITY_STATES` mirrors the `OpportunityState` union in
 * `core/opportunity/rule.ts` (once that module exists). Duplicated rather
 * than imported — AR-01 forbids `core/` importing from `src/db`, and every
 * CHECK below is the database's own half of that contract, exactly as
 * `wallets.targetMode`'s CHECK duplicates `TargetMode`.
 */
const OPPORTUNITY_STATES = ['buy', 'hold', 'sell'] as const;
const stateList = OPPORTUNITY_STATES.map((value) => `'${value}'`).join(', ');

/**
 * BR-018-01/05 — one rule per asset a user holds, watching one or two
 * user-chosen price thresholds.
 *
 * **Why `lower_state`/`upper_state` are nullable but each paired to its
 * bound.** BR-018-05 makes a bound itself optional — a rule may watch only a
 * floor, only a ceiling, or both. But BR-018-06 makes the *state* a bound
 * reports a deliberate, user-chosen fact, never a default the product
 * invents ("below R$30" is a buy for one strategy and a sell for another —
 * DL-018-02). A bound with no state attached would leave the evaluator
 * guessing what to display when the price crosses it, which is exactly the
 * product judgement this spec refuses to make. So the two columns rise and
 * fall together: `lower_bound_upper_state_paired_check` below enforces that
 * a bound without its state is not a bound at all, and a state with no bound
 * is not a threshold — either both are null (the bound is unset) or both are
 * set (the bound is real and means what its state says).
 *
 * **Why BR-018-08's ordering is a CHECK constraint here, not application
 * code.** Unlike SPEC-017's 100%-total invariant — which sums *across every
 * row* in a wallet's target set and genuinely cannot be expressed as a
 * row-level CHECK — "lower strictly less than upper" is a fact about the
 * two columns of a single row. Nothing outside this row is needed to decide
 * it, so there is no reason to trust application code to re-derive it on
 * every write path when Postgres can refuse the bad row outright, unconditionally,
 * regardless of which code wrote it. The issue #90 body makes the same
 * point: a single-row invariant belongs in the schema; a cross-row one
 * belongs in a locked application transaction.
 */
export const opportunityRules = pgTable(
  'opportunity_rules',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // No cascade, matching `positions.asset_id`: an asset is shared reference
    // data (AR-15) and is never deleted while a position or a rule on it is
    // live.
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    /** BR-018-05/09/10: a threshold in BRL. AR-06/AR-28: `NUMERIC(20,8)` via `Money`. */
    lowerBound: money('lower_bound'),
    /** BR-018-06: the user's own chosen meaning for crossing `lower_bound`. */
    lowerState: text('lower_state'),
    upperBound: money('upper_bound'),
    /** BR-018-06: the user's own chosen meaning for crossing `upper_bound`. */
    upperState: text('upper_state'),
    /** BR-018-07: applies strictly between the two bounds. Defaults to hold. */
    defaultState: text('default_state').notNull().default('hold'),
    /**
     * BR-018-13/21 — the last state a quote write evaluated this rule to,
     * so the next evaluation can tell a change from a repeat. Nullable:
     * a rule just created has never been evaluated, and that is a different
     * fact from having last evaluated to 'hold' — collapsing the two would
     * make a brand-new rule silently skip its first notification-worthy
     * transition because it looks like a repeat of a state that was never
     * actually observed.
     */
    lastState: text('last_state'),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    /**
     * BR-018-03 — a rule is deactivated, never deleted, when its position
     * closes to zero, and reactivates automatically if the asset is held
     * again. No `deleted_at`: a rule the user actually removes is really
     * removed, and "temporarily not applicable because the position closed"
     * is a wholly different fact from "the user asked for this to be gone".
     */
    active: boolean('active').notNull().default(true),
    /** BR-018-26 — a per-asset mute, independent of the global unsubscribe. */
    muted: boolean('muted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // BR-018-05: one rule per asset per user.
    unique('opportunity_rules_user_id_asset_id_key').on(table.userId, table.assetId),
    index('opportunity_rules_user_id_idx').on(table.userId),
    check(
      'opportunity_rules_lower_state_check',
      sql`${table.lowerState} IS NULL OR ${table.lowerState} IN (${sql.raw(stateList)})`,
    ),
    check(
      'opportunity_rules_upper_state_check',
      sql`${table.upperState} IS NULL OR ${table.upperState} IN (${sql.raw(stateList)})`,
    ),
    check(
      'opportunity_rules_default_state_check',
      sql`${table.defaultState} IN (${sql.raw(stateList)})`,
    ),
    check(
      'opportunity_rules_last_state_check',
      sql`${table.lastState} IS NULL OR ${table.lastState} IN (${sql.raw(stateList)})`,
    ),
    // BR-018-05: a rule with neither bound set watches nothing and is not valid.
    check(
      'opportunity_rules_at_least_one_bound_check',
      sql`${table.lowerBound} IS NOT NULL OR ${table.upperBound} IS NOT NULL`,
    ),
    // BR-018-06: a bound and its state are set together or not at all — see
    // the table comment above.
    check(
      'opportunity_rules_lower_bound_state_paired_check',
      sql`(${table.lowerBound} IS NULL) = (${table.lowerState} IS NULL)`,
    ),
    check(
      'opportunity_rules_upper_bound_state_paired_check',
      sql`(${table.upperBound} IS NULL) = (${table.upperState} IS NULL)`,
    ),
    // BR-018-08: strictly less, so no price can match both bounds — conflict
    // is impossible by construction (DL-018-03), not resolved by a
    // precedence rule the user cannot see. Only compares when both are set;
    // a rule with a single bound has nothing to order.
    check(
      'opportunity_rules_bounds_order_check',
      sql`${table.lowerBound} IS NULL OR ${table.upperBound} IS NULL OR ${table.lowerBound} < ${table.upperBound}`,
    ),
    // A threshold of zero or less is not a price a quote could ever reach.
    check(
      'opportunity_rules_lower_bound_positive_check',
      sql`${table.lowerBound} IS NULL OR ${table.lowerBound} > 0`,
    ),
    check(
      'opportunity_rules_upper_bound_positive_check',
      sql`${table.upperBound} IS NULL OR ${table.upperBound} > 0`,
    ),
  ],
);

/**
 * BR-018-24/DL-018-08 — one row per email actually sent, keyed on the
 * observation that triggered it.
 *
 * **No `last_notified_at` column on `opportunity_rules`.** BR-018-20's "time
 * of the last email sent" is `MAX(sent_at)` over this table for the rule.
 * Storing it twice would be storing a second thing that can disagree with
 * the log it is supposedly summarising — the log is already the source of
 * truth for every send, so a denormalised copy buys nothing and risks
 * drifting out of sync the first time a write to one forgets the other.
 *
 * **What `unique(rule_id, state, quote_observed_at)` is actually for.**
 * pg-boss delivers at least once (AR-19): a handler can send the email,
 * then crash or lose its connection before the transaction that records the
 * send commits. On retry, the handler evaluates the *same* quote again and
 * reaches the *same* state — nothing here has changed, only the delivery
 * attempt is repeating. Without this constraint, the retry's insert would
 * succeed and a second, identical email would go out for a state the user
 * was already told about. The constraint makes the second insert fail
 * instead, which is what makes "record the send, then rely on the log to
 * refuse a duplicate" a correct idempotency strategy rather than a
 * best-effort one. `state` is part of the key (not just `rule_id` and
 * `quote_observed_at`) because BR-018-21 is keyed on *state changes*, and a
 * single quote observation should never be able to produce two different
 * recorded states for the same rule.
 */
export const opportunityNotifications = pgTable(
  'opportunity_notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => opportunityRules.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    /**
     * The quote's own `quoted_at` — the observation that triggered this
     * send, not the instant the worker got around to sending it. AR-29: a
     * genuine instant, not a business date; two quotes taken seconds apart
     * during the same trading session are different observations.
     */
    quoteObservedAt: timestamp('quote_observed_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // BR-018-24/DL-018-08: THE idempotency key. See the table comment.
    unique('opportunity_notifications_rule_id_state_quote_observed_at_key').on(
      table.ruleId,
      table.state,
      table.quoteObservedAt,
    ),
    index('opportunity_notifications_user_id_idx').on(table.userId),
    // BR-018-20/22: "the time of the last email sent for this rule" and the
    // cooldown check are both `... WHERE rule_id = ? ORDER BY sent_at DESC`.
    index('opportunity_notifications_rule_id_sent_at_idx').on(table.ruleId, table.sentAt),
    check('opportunity_notifications_state_check', sql`${table.state} IN (${sql.raw(stateList)})`),
  ],
);
