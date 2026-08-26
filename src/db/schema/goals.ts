import { check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money } from '@/db/numeric';
import { users } from '@/db/schema/users';
import { wallets } from '@/db/schema/wallets';

/**
 * SPEC-019 — one row per goal a wallet is tracking. BR-019-02: a wallet may
 * hold several, of either kind, so there is no unique constraint narrower
 * than the primary key.
 *
 * `kind` decides which of `basis`/`period` applies, mirroring the
 * `GoalKind`/`GrowthBasis`/`EarningsPeriod` unions in `core/goals/goal.ts`
 * (AR-01 forbids this file being imported there, so the CHECK below is the
 * database's own half of that contract, duplicated rather than shared —
 * exactly as `wallets.targetMode`'s CHECK duplicates `TargetMode`).
 */
export const walletGoals = pgTable(
  'wallet_goals',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * BR-019-08: cascades from `wallets`, deliberately unlike
     * `wallet_allocation_events.wallet_id` (see that column's comment in
     * `wallets.ts`). A goal is an aspiration attached to a wallet, not a
     * historical fact about money that moved — deleting the wallet it was
     * about should not leave an orphaned target behind, and nothing here
     * touches `transactions` or `wallet_allocations` when it fires.
     */
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** BR-019-03/AR-30: `text` + CHECK, never a Postgres ENUM. */
    kind: text('kind').notNull(),
    /** BR-019-07/AR-28: `NUMERIC(20,8)` via `Money`, never a JS number. */
    amount: money('amount').notNull(),
    /** BR-019-05 — growth goals only; `null` for `earnings`. */
    basis: text('basis'),
    /** BR-019-06 — earnings goals only; `null` for `growth`. */
    period: text('period'),
    /**
     * BR-019-24/26 — an event, not a status. Nullable rather than a boolean:
     * once the goal is achieved this is set once and never cleared, so a
     * wallet that later drifts back below the amount still shows the date it
     * first got there. A boolean would have to be flipped back to false on
     * every re-evaluation that finds the goal no longer met, which is exactly
     * the retroactive erasure BR-019-26 forbids — this column records the
     * achievement event itself, and an event does not un-happen.
     *
     * **A `date`, not a `timestamptz`, and that is AR-29 doing real work
     * here.** BR-019-24 says "the date achieved", and the date a goal was
     * achieved is a fact about the portfolio, not about when the product
     * happened to notice: it is read off the burn-up's own crossing point or
     * off the pay date of the provento that carried an earnings goal over.
     * Those are business dates. Stamping the observation instant instead
     * would date a goal crossed in March 2023 to whenever the user first
     * imported their history and opened this page — which, for a product
     * whose onboarding *is* importing years of B3 extracts, is every goal any
     * new user has already met.
     */
    achievedOn: date('achieved_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wallet_goals_user_id_wallet_id_idx').on(table.userId, table.walletId),
    check('wallet_goals_kind_check', sql`${table.kind} IN ('growth', 'earnings')`),
    check(
      'wallet_goals_basis_check',
      sql`${table.basis} IS NULL OR ${table.basis} IN ('invested', 'current_value')`,
    ),
    check(
      'wallet_goals_period_check',
      sql`${table.period} IS NULL OR ${table.period} IN ('monthly', 'yearly')`,
    ),
    // BR-019-07: an amount of zero or less is not a goal.
    check('wallet_goals_amount_positive_check', sql`${table.amount} > 0`),
    // BR-019-03/05/06: growth carries a basis and no period; earnings carries
    // a period and no basis. Neither kind may leave its own field null while
    // filling in the other kind's.
    check(
      'wallet_goals_kind_fields_check',
      sql`(${table.kind} = 'growth' AND ${table.basis} IS NOT NULL AND ${table.period} IS NULL)
       OR (${table.kind} = 'earnings' AND ${table.period} IS NOT NULL AND ${table.basis} IS NULL)`,
    ),
  ],
);
