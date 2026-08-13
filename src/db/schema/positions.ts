import { check, index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, quantity } from '@/db/numeric';
import { assets, institutions } from '@/db/schema/assets';
import { users } from '@/db/schema/users';

/**
 * SPEC-007 — the position cache.
 *
 * **This table is derived, not authoritative** (BR-006-01, DL-006-01). Every
 * row is reproducible by replaying `transactions`, and if the two ever
 * disagree the ledger wins and this table is rebuilt (BR-007-14, DM-4). That
 * is why nothing in the codebase increments a column here: positions are only
 * ever overwritten with a replayed value.
 *
 * It exists at all for SPEC-016's budgets — reports read a stored position
 * rather than replaying a five-year ledger on every page load.
 */
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    institutionId: uuid('institution_id').references(() => institutions.id),
    // AR-06/AR-28: NUMERIC(20,8) throughout. AR-09: these are stored at full
    // precision — the average is a division and rounding it here would be
    // rounding an intermediate, which CR-3 forbids. Rounding happens at
    // display, in the i18n formatter, and nowhere else.
    quantity: quantity('quantity').notNull(),
    averageCost: money('average_cost').notNull(),
    totalCost: money('total_cost').notNull(),
    realizedGain: money('realized_gain').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * SPEC-007 BR-007-08: one position per `(user, asset, institution)`.
     *
     * `NULLS NOT DISTINCT` is the load-bearing part. Postgres's default treats
     * every NULL as unique, so without it a user holding an asset with **no**
     * institution recorded could accumulate an unbounded number of duplicate
     * position rows for the same holding — each upsert inserting rather than
     * updating, and every portfolio total silently multiplying. Postgres 15+
     * only; the deployment target is 17.
     */
    unique('positions_user_asset_institution_key')
      .on(table.userId, table.assetId, table.institutionId)
      .nullsNotDistinct(),
    index('positions_user_id_idx').on(table.userId),
    index('positions_user_id_asset_id_idx').on(table.userId, table.assetId),
    // A negative quantity is not a position, it is a replay bug that escaped
    // `applyWithdrawal`'s guard. Fail at the floor rather than serve it.
    check('positions_quantity_non_negative_check', sql`${table.quantity} >= 0`),
    // BR-007-07: a closed position resets — quantity zero implies no residual
    // cost and no residual average. Realized gain deliberately survives, which
    // is why it is not part of this constraint.
    check(
      'positions_closed_reset_check',
      sql`${table.quantity} > 0 OR (${table.totalCost} = 0 AND ${table.averageCost} = 0)`,
    ),
  ],
);
