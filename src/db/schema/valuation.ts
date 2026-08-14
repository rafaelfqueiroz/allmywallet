import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money } from '@/db/numeric';
import { users } from '@/db/schema/users';

/**
 * SPEC-009 BR-009-16 — the daily valuation snapshot.
 *
 * **Derived cache, never authoritative** (BR-009-17, DL-009-06). Every row is
 * reproducible from `transactions`, `price_quotes` and `index_series`, and
 * where this table disagrees with a recomputation the ledger wins and this is
 * rebuilt. That is why nothing in the codebase increments a column here: a
 * snapshot is only ever overwritten with a freshly derived one.
 *
 * It exists at all for SPEC-016 BR-016-05's budget — reports read a stored
 * snapshot rather than replaying five years of ledger on every page load
 * (TS-32 enforces that structurally).
 *
 * Tenant-scoped: a row states exactly what someone's portfolio was worth on a
 * given day. RLS ships in the same migration (AR-14).
 */
export const dailyValuationSnapshots = pgTable(
  'daily_valuation_snapshots',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // AR-29: a business date, never a timestamp. "What the portfolio was worth
    // on 15 March" is a date question; a timestamp would shift the answer
    // across a period boundary depending on the reader's timezone.
    date: date('date').notNull(),
    // AR-06/AR-09: NUMERIC(20,8) at full precision. Rounding happens once, at
    // display, in the i18n formatter — CR-3 forbids rounding an intermediate,
    // and every figure here is an intermediate for some report.
    totalValue: money('total_value').notNull(),
    /**
     * External flows only — buys and transfers in, less sells and transfers
     * out. Not price change, never earnings. SPEC-012's TWR neutralises
     * exactly this column and nothing else, which is why it is stored rather
     * than re-derived: the definition must not drift between reports.
     */
    netContributions: money('net_contributions').notNull(),
    /** Proventos recognised at pay date (SPEC-014), cumulative to this date. */
    earningsToDate: money('earnings_to_date').notNull(),
    /**
     * AR-10: `Money` serialised with `toString()`, never through
     * `JSON.stringify` on a `Decimal` — which would come back a float and
     * lose the tail silently. Keys are asset classes; values are plain
     * decimal strings. Shaped by `serializeSnapshot` in
     * `core/valuation/snapshot.ts`, which is also what imposes a deterministic
     * key order so two rebuilds serialise identically (DM-4).
     */
    byAssetClass: jsonb('by_asset_class').notNull().$type<Record<string, string>>(),
    /**
     * BR-009-11 / DL-009-02 — drives the UI's estimate marker. True when any
     * component of `total_value` was **accrued** rather than observed: bank
     * paper priced from its contracted indexer, or a position that fell back
     * to cost because it could not be priced at all (BR-009-13).
     *
     * Deliberately *not* set by a carried-forward close (BR-009-03). That is
     * still an observed price, just an older one, and flagging it here would
     * mark every weekend's snapshot an estimate — draining the marker of the
     * meaning it exists to carry.
     */
    hasEstimates: boolean('has_estimates').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * BR-009-16: one row per user per day. The composite primary key is also
     * what makes the writer idempotent (AR-19) — a retried `valuation.snapshot`
     * job upserts on this key rather than appending a second row for the same
     * day, which would double every total that summed the table.
     */
    primaryKey({ columns: [table.userId, table.date] }),
    // The Portfolio Value chart's access pattern: one tenant, a date range,
    // in order. The primary key already leads with `user_id`, so this exists
    // for the range scan rather than for the lookup.
    index('daily_valuation_snapshots_user_id_date_idx').on(table.userId, table.date),
    /**
     * A portfolio cannot be worth less than nothing: this product tracks no
     * liabilities and no margin (the PRD's reason for calling the figure
     * *patrimônio* rather than net worth). A negative total is a replay or
     * pricing defect, and failing at the floor beats serving it.
     *
     * `net_contributions` and `earnings_to_date` carry no such constraint —
     * net contributions legitimately go negative once a user has withdrawn
     * more than they put in, which is the normal end state of a wound-down
     * position.
     */
    check('daily_valuation_snapshots_total_non_negative_check', sql`${table.totalValue} >= 0`),
  ],
);
