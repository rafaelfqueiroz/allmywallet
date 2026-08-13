import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, quantity, rate } from '@/db/numeric';
import { assets, institutions } from '@/db/schema/assets';
import { users } from '@/db/schema/users';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@/core/ledger/transaction';

/**
 * SPEC-006 — the transaction ledger. BR-006-01: the single source of truth.
 * Everything else in the product is derived from these rows and rebuildable
 * from them alone (DM-4, DL-006-01).
 */

/**
 * BR-006-02: provenance. Every transaction records the batch it came from, or
 * carries none and is a manual entry.
 *
 * SPEC-005 owns this table's real shape — file name, row counts, reconciliation
 * outcome, the preview/commit lifecycle. What is here is the minimum that makes
 * `transactions.import_batch_id` a genuine foreign key rather than a loose
 * uuid. Deliberately **no file name column**: it is the one field that could
 * carry personal data (users name exports after themselves), and SPEC-004
 * BR-004-02's CPF discipline is much easier to keep if the column arrives with
 * the spec that has thought about it.
 */
const IMPORT_SOURCES = ['b3_movimentacao', 'b3_negociacao', 'b3_posicao', 'manual'] as const;
const IMPORT_STATUSES = ['pending', 'previewed', 'committed', 'discarded'] as const;

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey(),
    // AR-26/AR-27: the cascade is load-bearing — it is what makes SPEC-004's
    // account deletion complete without a bespoke cleanup step.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_batches_user_id_idx').on(table.userId),
    check(
      'import_batches_source_check',
      sql`${table.source} IN (${sql.raw(IMPORT_SOURCES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'import_batches_status_check',
      sql`${table.status} IN (${sql.raw(IMPORT_STATUSES.map((v) => `'${v}'`).join(', '))})`,
    ),
  ],
);

/**
 * The CHECK lists are generated from the same constants the domain uses
 * (`core/ledger/transaction.ts`), so BR-006-05's thirteen types and BR-006-03's
 * three statuses cannot drift between the type system and the database. A
 * hand-copied list is a list that is wrong exactly once.
 */
const typeList = TRANSACTION_TYPES.map((value) => `'${value}'`).join(', ');
const statusList = TRANSACTION_STATUSES.map((value) => `'${value}'`).join(', ');

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    /** Null is a real bucket — an asset held with no institution recorded. */
    institutionId: uuid('institution_id').references(() => institutions.id),
    type: text('type').notNull(),
    status: text('status').notNull().default('active'),
    /**
     * AR-29: a `date`, not a timestamp, and this is the single most consequential
     * column type in the schema. A trade on 2026-03-15 in São Paulo is that date
     * regardless of the reader's timezone; storing an instant invites an
     * off-by-one that shifts transactions across period boundaries and corrupts
     * every report by a day at the edges.
     */
    tradeDate: date('trade_date').notNull(),
    // AR-06/AR-28: NUMERIC(20,8) via the custom types, which parse to
    // Money/Quantity on read and serialise on write. Never float, never `money`.
    quantity: quantity('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    fees: money('fees').notNull(),
    totalValue: money('total_value').notNull(),
    /**
     * SPEC-007 BR-007-04: the multiplier a split or grupamento applies to
     * quantity — 2 for a 1:2 desdobramento, 0.1 for a 10:1 grupamento.
     *
     * Not in the issue's data model; added because BR-007-04 is stated in terms
     * of a ratio and the alternative was overloading `unit_price` to mean
     * something other than a price on two of the thirteen types. The CHECK below
     * enforces the pairing so a split can never reach the engine without one.
     */
    ratio: rate('ratio'),
    naturalKey: text('natural_key').notNull(),
    /** BR-006-04 / TS-21: two genuinely identical same-day trades are real. */
    occurrence: integer('occurrence').notNull().default(1),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    isManual: boolean('is_manual').notNull().default(false),
    /** BR-006-16: a re-import must not revert a correction. */
    isUserModified: boolean('is_user_modified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // BR-006-04: unique per user, enforced by the database (DM-1) rather than
    // by an application check that races itself under a concurrent re-import.
    unique('transactions_user_natural_key_occurrence_key').on(
      table.userId,
      table.naturalKey,
      table.occurrence,
    ),
    index('transactions_user_id_trade_date_idx').on(table.userId, table.tradeDate),
    // The replay index: `listForPosition` is the hottest query in the system,
    // running on every write and every rebuild.
    index('transactions_user_asset_institution_idx').on(
      table.userId,
      table.assetId,
      table.institutionId,
      table.tradeDate,
    ),
    index('transactions_user_id_asset_id_trade_date_idx').on(
      table.userId,
      table.assetId,
      table.tradeDate,
    ),
    check('transactions_type_check', sql`${table.type} IN (${sql.raw(typeList)})`),
    check('transactions_status_check', sql`${table.status} IN (${sql.raw(statusList)})`),
    // SPEC-007 BR-007-04/BR-007-15. A split with no ratio cannot be replayed,
    // and a ratio on a buy is a mis-typed row — both are refused at the floor,
    // not only in `core/ledger/validate.ts`, because the import path writes
    // here too.
    check(
      'transactions_ratio_pairing_check',
      sql`(${table.type} IN ('split', 'grupamento') AND ${table.ratio} IS NOT NULL AND ${table.ratio} > 0)
          OR (${table.type} NOT IN ('split', 'grupamento') AND ${table.ratio} IS NULL)`,
    ),
    check('transactions_fees_non_negative_check', sql`${table.fees} >= 0`),
    check('transactions_unit_price_non_negative_check', sql`${table.unitPrice} >= 0`),
    check('transactions_occurrence_positive_check', sql`${table.occurrence} >= 1`),
  ],
);
