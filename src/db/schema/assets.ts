import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Shared reference tables — AR-15 / SPEC-003 BR-003-06: they hold no personal
 * data and are exempt from tenant scoping **by explicit declaration**. Both are
 * already named on `src/db/shared-tables.ts`'s `SHARED_TABLES`, so the
 * enumeration gate will not ask them for a `user_id` or an RLS policy.
 *
 * They are created here, by SPEC-006, rather than by SPEC-008 which owns their
 * full shape, for a structural reason: `transactions.asset_id` is a foreign
 * key, and a ledger whose asset reference points at nothing is not referential
 * integrity, it is a text column with ambitions. The columns below are the
 * minimum the ledger needs — SPEC-008 extends them (ticker suffixes, ISIN,
 * segment, quote provider mapping) by a later migration, which is additive and
 * therefore expand/contract safe (DV-27, AR-69).
 */

/**
 * The eight classes v1 consolidates, per the PRD. `text` + `CHECK` rather than
 * a Postgres `ENUM` (AR-30) — adding a ninth class is then an ordinary
 * migration instead of an `ALTER TYPE` that cannot run inside a transaction.
 */
export const ASSET_CLASSES = [
  'stock',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

const assetClassList = ASSET_CLASSES.map((value) => `'${value}'`).join(', ');

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    /** The B3 ticker or the instrument's identifying code — `PETR4`, `HGLG11`. */
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    assetClass: text('class').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('assets_class_check', sql`${table.assetClass} IN (${sql.raw(assetClassList)})`),
    // SPEC-006 BR-006-09: search finds assets by code **and by name**, so both
    // are indexed. Trigram/full-text search is SPEC-008's problem once the
    // asset catalogue is large; at v1 volumes a prefix index on a sorted
    // column is what the query planner will actually use.
    index('assets_name_idx').on(table.name),
    index('assets_class_idx').on(table.assetClass),
  ],
);

/**
 * The broker or bank a position is held at. SPEC-007 BR-007-08 tracks
 * positions per `(user, asset, institution)`, so this is part of a position's
 * identity rather than a label on it.
 */
export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
