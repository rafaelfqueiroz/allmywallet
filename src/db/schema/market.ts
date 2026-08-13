import {
  check,
  index,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, rate } from '@/db/numeric';
import { assets } from './assets';

/**
 * SPEC-008 — market data tables. All four are shared reference/aggregate
 * tables: no personal data, no `user_id`, exempt from RLS by explicit
 * declaration (`src/db/shared-tables.ts`, AR-15/BR-003-06). Quotes are the
 * same for every tenant (BR-008-25), and budget usage is a process-wide
 * counter, not a per-user one.
 *
 * The instrument catalog itself is NOT here. `assets` is created by SPEC-006
 * (`./assets.ts`) because `transactions.asset_id` needs a foreign key target;
 * this file references it rather than redefining it. Two consequences worth
 * stating, because both are load-bearing:
 *
 * 1. Its identifier column is `code`, not `ticker`. That is the better name
 *    for a table that also holds Tesouro Direto titles (`Tesouro IPCA+ 2029`
 *    is not a ticker) and fixed income. `ticker` survives only in the
 *    provider-facing ports, where it genuinely is a ticker.
 * 2. Its CHECK admits all eight classes the PRD lists, including CDB/LCI/LCA.
 *    SPEC-008 narrows that to the five it can price, but it does so in the
 *    domain (`core/quotes/ports.ts`) and in `derivePollingSet`'s class
 *    filter, not by constraining a table the ledger also writes to.
 */

/**
 * Authoritative close-price history. BR-008-09/BR-008-10: only the official
 * close is ever written here, keyed `(asset_id, date)` so an intraday quote
 * is *structurally* incapable of touching a historical row — it lives in
 * `latest_quotes` instead. One row per asset per trading day, forever.
 */
export const priceQuotes = pgTable(
  'price_quotes',
  {
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    close: money('close').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.date] }),
    index('price_quotes_asset_id_idx').on(table.assetId),
  ],
);

/**
 * Delayed intraday quote, one row per asset, overwritten on every refresh
 * (BR-008-10: it never becomes history). `quoted_at` is the provider's
 * as-of timestamp (~30 min behind); `fetched_at` is when this system asked —
 * BR-008-04 shows both so the delay is never implied to be zero.
 */
export const latestQuotes = pgTable('latest_quotes', {
  assetId: uuid('asset_id')
    .primaryKey()
    .references(() => assets.id, { onDelete: 'cascade' }),
  price: money('price').notNull(),
  quotedAt: timestamp('quoted_at', { withTimezone: true }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const INDEX_SERIES_CODES = ['CDI', 'IPCA', 'SELIC', 'IBOV'] as const;

/** BCB SGS series 12 (CDI), 433 (IPCA), 11 (Selic), plus IBOV. Daily, backfilled on first load. */
export const indexSeries = pgTable(
  'index_series',
  {
    code: text('code').notNull(),
    date: date('date').notNull(),
    value: rate('value').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.code, table.date] }),
    check('index_series_code_check', sql`${table.code} IN ('CDI', 'IPCA', 'SELIC', 'IBOV')`),
  ],
);

/**
 * DEVIATION from the issue's Modules table (flagged in the dispatch report,
 * not a silent addition): BR-008-19..24's budget accounting needs a
 * persisted call counter that survives a restart. `latest_quotes` is
 * overwritten on every refresh and cannot reconstruct how many intraday
 * calls happened this month; `price_quotes` only captures one row per
 * asset/day. Neither can answer "how much of the quota is spent", so this
 * table exists to answer it. Partitioned into 'scheduled'/'ondemand' so the
 * BR-008-20 reserve is a real wall, not a derived split. Holds counts only —
 * no personal data — so it is declared shared, the same reasoning
 * `runtime_state` used for SPEC-002 (`src/db/shared-tables.ts`).
 */
export const quoteBudgetUsage = pgTable(
  'quote_budget_usage',
  {
    yearMonth: text('year_month').notNull(),
    kind: text('kind').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.yearMonth, table.kind] }),
    check('quote_budget_usage_kind_check', sql`${table.kind} IN ('scheduled', 'ondemand')`),
  ],
);
