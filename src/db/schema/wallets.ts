import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, quantity } from '@/db/numeric';
import { assets } from '@/db/schema/assets';
import { users } from '@/db/schema/users';

/**
 * SPEC-010 — wallets, their allocations against held positions, and the
 * opt-in standing rule that routes future purchases of a split asset.
 *
 * All three tables are tenant-scoped (AR-14): `user_id`, ENABLE + FORCE row
 * level security, and a `USING`/`WITH CHECK` policy ship in the same
 * migration that creates them (`0007_wallets.sql`).
 */

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** BR-010-02: descriptive only in v1 — never read by any calculation. */
    goal: text('goal'),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('wallets_user_id_idx').on(table.userId)],
);

/**
 * DM-2 — one row per `(user, wallet, asset)`. BR-010-04: allocation is
 * stored **by quantity**, which is what lets a position be split
 * deliberately (100 ITSA4 as 60 Retirement / 40 Trading) without ever
 * tagging a transaction (BR-010-08's "wallets are views over the ledger").
 *
 * ---------------------------------------------------------------------
 * THE SUM INVARIANT IS NOT ENFORCED BY THIS SCHEMA.
 *
 * BR-010-05: total allocated quantity per `(user, asset)` may never exceed
 * the quantity actually held. That is a constraint **across rows** —
 * `sum(quantity) FILTER (WHERE asset_id = ...) <= held_quantity` — and
 * Postgres has no row-level CHECK that can express it; `held_quantity`
 * itself lives in a different table (`positions`) entirely.
 *
 * It is enforced in application code instead, in
 * `src/adapters/db/wallet-repository.ts`, by every write path
 * (`allocate.ts`, `apply-buy.ts`, `apply-sell.ts`,
 * `apply-corporate-event.ts`) first taking `SELECT ... FOR UPDATE` over
 * every allocation row for the asset, inside the same `withTenant`
 * transaction as the write that follows — see `core/wallets/ports.ts`'s
 * `WalletAllocationRepository.lockForAsset` for the contract. The adapter
 * additionally locks the asset's `positions` row(s) first, closing the
 * phantom-row gap `FOR UPDATE` alone leaves for an asset's very first
 * allocation (nothing exists yet in `wallet_allocations` to lock). See
 * `tests/integration/wallet-allocation-invariant.test.ts` for the proof
 * under genuinely concurrent writes.
 *
 * Nobody reading this table directly may assume the sum invariant holds —
 * a bulk `UPDATE`, a hand-run migration, or a future code path that writes
 * through anything other than `lockForAsset` can violate it, and nothing
 * here will stop that write or even notice it happened.
 * ---------------------------------------------------------------------
 */
export const walletAllocations = pgTable(
  'wallet_allocations',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    quantity: quantity('quantity').notNull(),
    /**
     * BR-010-22: the wallet's own accumulated cost of its allocated shares —
     * see `core/wallets/ports.ts`'s `WalletAllocation.costBasisAtAllocation`
     * for exactly how each write path maintains it. Nullable because not
     * every allocation necessarily has cost information available.
     */
    costBasisAtAllocation: money('cost_basis_at_allocation'),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('wallet_allocations_user_wallet_asset_key').on(
      table.userId,
      table.walletId,
      table.assetId,
    ),
    index('wallet_allocations_user_id_idx').on(table.userId),
    // The hot path for the sum invariant's lock — every write to any wallet
    // holding this asset takes `SELECT ... FOR UPDATE` filtered on exactly
    // this pair.
    index('wallet_allocations_user_id_asset_id_idx').on(table.userId, table.assetId),
    index('wallet_allocations_wallet_id_idx').on(table.walletId),
    // A row with a non-positive quantity is not a split, it is a bug — an
    // allocation reduced to zero is deleted (see apply-sell.ts), never stored
    // at zero, so BR-010-06's Unassigned bucket has exactly one representation.
    check('wallet_allocations_quantity_positive_check', sql`${table.quantity} > 0`),
  ],
);

/**
 * BR-010-14/DL-010-04 — the opt-in standing rule. Primary key `(user_id,
 * asset_id)`, per the issue's data model: an asset can have at most one
 * standing destination, which is exactly what "the user's own instruction"
 * (rather than an inference) means — there is nothing to disambiguate once
 * it is set.
 */
export const walletAssetRules = pgTable(
  'wallet_asset_rules',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.assetId] }),
    index('wallet_asset_rules_user_id_idx').on(table.userId),
    index('wallet_asset_rules_wallet_id_idx').on(table.walletId),
  ],
);
