import { check, date, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * SPEC-008 BR-008-29 (#113) — B3's published corporate-event factor for a
 * split (*desdobramento*), reverse split (*grupamento*) or bonus
 * (*bonificação*), read from B3's public listed-companies data (no key, no
 * credential, no user data sent — BR-003-08). It is used **only to confirm**
 * a ratio derived from custody data (SPEC-007 BR-007-04a); it never creates,
 * moves or classifies a transaction by itself.
 *
 * Shared across tenants like `price_quotes` (BR-008-25): the factor is
 * public market data keyed by issuer, not by tenant. Declared in
 * `src/db/shared-tables.ts`; no `user_id`, no RLS (AR-15 — AR-14 applies to
 * tenant tables, and this is deliberately not one).
 *
 * `factor_published` is deliberately `text`, not the `rate` custom type
 * (`NUMERIC(20,8)`): B3 states some factors at more than eight decimal
 * places, which an 8-decimal-place column would silently truncate. The
 * verbatim, `.`-decimal string as B3 published it is the value this table
 * stores; PR-B's `core/positions/share-ratio.ts` is the one place that
 * parses it to `Quantity`, and only there.
 */
export const CORPORATE_EVENT_FACTOR_KINDS = ['desdobramento', 'grupamento', 'bonificacao'] as const;

export type CorporateEventFactorKind = (typeof CORPORATE_EVENT_FACTOR_KINDS)[number];

export const corporateEventFactors = pgTable(
  'corporate_event_factors',
  {
    id: uuid('id').primaryKey(),
    /** B3's issuer code, e.g. `MGLU` — not a ticker, no class (ON/PN/unit). */
    issuerCode: text('issuer_code').notNull(),
    kind: text('kind').notNull(),
    factorPublished: text('factor_published').notNull(),
    /** B3's "última data com" — the last date the factor applies to a holder. */
    lastDatePrior: date('last_date_prior').notNull(),
    /** Null where B3's response carries no approval date for this event. */
    approvedOn: date('approved_on'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('corporate_event_factors_issuer_code_idx').on(table.issuerCode),
    // The adapter's fetch is idempotent against B3's own response — refetching
    // the same event writes nothing new.
    unique('corporate_event_factors_issuer_kind_date_factor_key').on(
      table.issuerCode,
      table.kind,
      table.lastDatePrior,
      table.factorPublished,
    ),
    check(
      'corporate_event_factors_kind_check',
      sql`${table.kind} IN ('desdobramento', 'grupamento', 'bonificacao')`,
    ),
  ],
);

/**
 * SPEC-008 BR-008-29 — one row per issuer, the outcome of the last attempt to
 * fetch its factor set from B3's public listed-companies endpoint (PR-B's
 * `adapters/market-data/b3-listed-companies.ts`). Refreshed after 7 days or
 * on failure (a config-registry cadence, SPEC-002, not a constant) rather
 * than on every commit — an outage leaves rows unconfirmed and never fails a
 * commit (BR-008-29).
 *
 * Shared, same reasoning as `corporate_event_factors` above: an issuer's
 * fetch outcome is not tenant data.
 */
export const CORPORATE_EVENT_FACTOR_FETCH_OUTCOMES = ['ok', 'not_listed', 'failed'] as const;

export type CorporateEventFactorFetchOutcome =
  (typeof CORPORATE_EVENT_FACTOR_FETCH_OUTCOMES)[number];

export const corporateEventFactorFetches = pgTable(
  'corporate_event_factor_fetches',
  {
    issuerCode: text('issuer_code').primaryKey(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    outcome: text('outcome').notNull(),
    /** Set only when `outcome = 'failed'` — matches `import_batches.failure_code`'s pattern. */
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'corporate_event_factor_fetches_outcome_check',
      sql`${table.outcome} IN ('ok', 'not_listed', 'failed')`,
    ),
  ],
);
