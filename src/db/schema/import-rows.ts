import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, rate } from '@/db/numeric';
import { assets, institutions } from '@/db/schema/assets';
import { importBatches, transactions } from '@/db/schema/transactions';
import { users } from '@/db/schema/users';
import { IMPORT_ROW_CLASSIFICATIONS } from '@/core/ingestion/ports';
import { FIXED_INCOME_INDEXERS } from '@/core/valuation/ports';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';

/**
 * SPEC-005 — the two new tables. Both are tenant-scoped (AR-14): `user_id`,
 * ENABLE + FORCE row level security, and a `USING`/`WITH CHECK` policy ship
 * in the same migration that creates them (`0009_import_and_fixed_income.sql`).
 *
 * **`import_rows` carries its own `user_id`, deliberately.** The issue's data
 * model gave it only `batch_id`, which would need a policy joining through
 * `import_batches` to know who owns a row. A direct `user_id` column instead
 * matches every other tenant table in this schema, is what
 * `tests/isolation/enumeration.test.ts`'s gate expects (it fails a table
 * lacking one), and is one join cheaper on the hottest read in this feature
 * — the preview list, run once per staged row.
 */

/**
 * BR-005-11/19/20/22 — one row per staged extract row. `raw_payload` is
 * CPF-free before it is ever constructed (`adapters/ingestion/xlsx/strip-cpf.ts`
 * runs first, in the parser adapter — BR-005-07/BR-004-02).
 */
const importRowClassificationList = IMPORT_ROW_CLASSIFICATIONS.map((v) => `'${v}'`).join(', ');
const ledgerTypeList = TRANSACTION_TYPES.map((v) => `'${v}'`).join(', ');

export const importRows = pgTable(
  'import_rows',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    /** CPF-free (BR-005-07). Keyed by source column header, string-valued only. */
    rawPayload: jsonb('raw_payload').notNull().$type<Record<string, string>>(),
    /** The `NormalizedRecord`, AR-10-serialised (Money/Quantity as decimal strings). */
    parsedPayload: jsonb('parsed_payload').notNull().$type<Record<string, unknown>>(),
    classification: text('classification').notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    institutionId: uuid('institution_id').references(() => institutions.id),
    /** Null for a `position` row — Posição rows never carry a natural key. */
    naturalKey: text('natural_key'),
    occurrence: integer('occurrence'),
    /** The `TransactionType` this row was/will be written to the ledger as. Null for `position` rows. */
    ledgerType: text('ledger_type'),
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('import_rows_user_id_idx').on(table.userId),
    index('import_rows_batch_id_idx').on(table.batchId),
    index('import_rows_user_id_batch_id_idx').on(table.userId, table.batchId),
    check(
      'import_rows_classification_check',
      sql`${table.classification} IN (${sql.raw(importRowClassificationList)})`,
    ),
    check(
      'import_rows_ledger_type_check',
      sql`${table.ledgerType} IS NULL OR ${table.ledgerType} IN (${sql.raw(ledgerTypeList)})`,
    ),
  ],
);

/**
 * BR-005-06 — contracted rate, indexer, issue and maturity date extracted
 * from the Posição fixed-income tab. SPEC-009's `FixedIncomeContractPort`
 * (`core/valuation/ports.ts`) is the read side; `upsertByAsset`
 * (`FixedIncomeContractWriterPort`) is this table's only writer.
 *
 * `unique(user_id, asset_id)`: BR-005-06's "creating or updating" is a single
 * contract per asset, not a history of them — a later Posição import
 * overwrites the previous reading rather than accumulating rows.
 */
const indexerList = FIXED_INCOME_INDEXERS.map((v) => `'${v}'`).join(', ');

export const fixedIncomeContracts = pgTable(
  'fixed_income_contracts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    /** Null where the extract's indexer text could not be read (BR-009-13). */
    indexer: text('indexer'),
    /** A percentage — `110` for 110% of CDI — matching `FixedIncomeContract.ratePercent` (AR-06/28). */
    rate: rate('rate'),
    // AR-29: a `date`, not a timestamp — an issue/maturity date is a
    // calendar date regardless of the reader's timezone.
    issueDate: date('issue_date').notNull(),
    maturityDate: date('maturity_date'),
    /** Reconciliation/"Needs attention" only — never the accrual base (see `core/valuation/accrual.ts`). */
    principal: money('principal'),
    source: uuid('source').references(() => importBatches.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('fixed_income_contracts_user_asset_key').on(table.userId, table.assetId),
    index('fixed_income_contracts_user_id_idx').on(table.userId),
    check(
      'fixed_income_contracts_indexer_check',
      sql`${table.indexer} IS NULL OR ${table.indexer} IN (${sql.raw(indexerList)})`,
    ),
  ],
);
