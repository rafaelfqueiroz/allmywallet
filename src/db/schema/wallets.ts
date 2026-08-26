import {
  check,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { money, quantity, rate } from '@/db/numeric';
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
    /**
     * SPEC-017 BR-017-02 — which target mode this wallet is in. Stored,
     * because it is a **standing instruction** rather than a one-off
     * calculation: `equal_weight` means "keep these equal", and BR-017-06 acts
     * on it every time the wallet's asset set changes.
     *
     * `'none'` is the default and is what every wallet created before this
     * column existed reads as, which is BR-017-01's "a wallet without targets
     * behaves exactly as it does today" obtained from the schema rather than
     * from a code path that has to remember.
     *
     * Mirrors `TARGET_MODES` in `core/wallets/targets.ts`. Duplicated rather
     * than imported, exactly as `AssetClass` is in `core/quotes/ports.ts`:
     * AR-01 forbids `core/` importing from `src/db`, and the CHECK below is
     * the half that has to live here.
     */
    targetMode: text('target_mode').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wallets_user_id_idx').on(table.userId),
    check(
      'wallets_target_mode_check',
      sql`${table.targetMode} IN ('none', 'equal_weight', 'manual')`,
    ),
  ],
);

/**
 * SPEC-017 DM — one row per `(wallet, asset)` the user has hand-set a target
 * percentage for.
 *
 * **Rows exist in `manual` mode only.** Equal-weight stores nothing: BR-017-05
 * derives `100 / n` on read, which is what makes BR-017-06's automatic
 * recompute free — an asset joining an equal-weight wallet changes every
 * target without touching a single row, so there is no migration of stored
 * percentages to get wrong and no window in which the stored set disagrees
 * with the wallet's actual holdings.
 *
 * ---------------------------------------------------------------------
 * THE 100 % INVARIANT IS NOT ENFORCED BY THIS SCHEMA.
 *
 * BR-017-04: a wallet's manual targets must total **exactly** 100. That is a
 * constraint **across rows** — `sum(target_pct) = 100` per wallet — and
 * Postgres has no row-level CHECK that can express it. The per-row CHECK below
 * bounds each value to 0–100 and nothing more.
 *
 * It is enforced in application code instead, by
 * `WalletTargetRepository.lockForWallet` (`core/wallets/ports.ts`) taking
 * `SELECT ... FOR UPDATE` over the wallet's target rows inside the same
 * `withTenant` transaction as the write that follows — the same shape
 * `wallet_allocations` uses for BR-010-05, and for the same reason: two
 * concurrent edits that each individually total 100 would otherwise interleave
 * into a set that does not. `tests/integration/wallet-target-invariant.test.ts`
 * is the proof under genuinely concurrent writes.
 *
 * There is no phantom-row gap here, unlike `lockForAsset`: the lock is taken
 * on the **wallet** row itself (which always exists — a target set belongs to
 * a wallet), so a wallet with no targets yet is still serialised.
 * ---------------------------------------------------------------------
 */
export const walletTargets = pgTable(
  'wallet_targets',
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
    /**
     * BR-017-03: a percentage of **market value**, 0–100.
     *
     * `rate` (NUMERIC(20,8) → `Quantity`) rather than the `numeric(9,6)` the
     * issue's data model sketched, so the column round-trips through
     * `src/db/numeric.ts` like every other non-money decimal in the project and
     * a percentage can never exist as a JS `number` between the database and
     * the domain (AR-06/AR-07). The extra scale is harmless: 100 ÷ 3 is not
     * representable at six places either, and equal-weight never stores a row
     * at all.
     */
    targetPct: rate('target_pct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('wallet_targets_wallet_id_asset_id_key').on(table.walletId, table.assetId),
    index('wallet_targets_user_id_wallet_id_idx').on(table.userId, table.walletId),
    check(
      'wallet_targets_target_pct_range_check',
      sql`${table.targetPct} >= 0 AND ${table.targetPct} <= 100`,
    ),
  ],
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

/**
 * SPEC-014 BR-014-12 — **what each wallet held, on the day each provento was
 * paid.**
 *
 * `wallet_allocations` cannot answer that. It carries one mutable row per
 * `(wallet, asset)`: a buy increments it, a sale reduces it, a corporate event
 * scales it, an assignment moves it, and no prior state survives. Attributing
 * last year's income with today's split would rewrite years of a wallet's
 * income history the moment someone reassigns a holding — a number that
 * changes when nothing about the past did, which is exactly what BR-014-12
 * forbids and what DL-014-05 explains.
 *
 * **A log of states, not of deltas.** Each row records the allocation's
 * quantity *after* the change, so "what did this wallet hold on date D" is the
 * latest row at or before D for each `(wallet, asset)` — a fold with no
 * arithmetic in it. A delta log would need the previous quantity read under a
 * lock at every write, and any missed or double-written event would corrupt
 * every later answer rather than one of them. A removal is a row with
 * quantity zero, for the same reason: absence has to be recorded, not
 * inferred from a gap.
 *
 * **This is not the per-day dimension #50 declined.** That was
 * `daily_valuation_snapshots` gaining a breakdown column per dimension — rows
 * multiplying by cardinality over every day of history, on the rebuild path.
 * This grows with allocation *changes*, of which a real portfolio has a
 * handful per asset per year, and nothing rebuilds it: it is append-only,
 * written where the allocation is written.
 *
 * **`effective_on` is the trade date, not the clock.** A user importing four
 * years of B3 extracts today creates four years of allocation history in one
 * afternoon; stamping those events with `now()` would attribute every past
 * provento to a wallet that, as far as this log knew, held nothing at the
 * time. Hence AR-29 applies here as it does to every other business date: the
 * date the movement happened, never the instant the row was written.
 */
export const walletAllocationEvents = pgTable(
  'wallet_allocation_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * No `ON DELETE cascade` to `wallets`, unlike `wallet_allocations`.
     * Deleting a wallet must not delete the record that it once held
     * something — last year's income did not stop having been earned. The
     * wallet's *name* goes with the row it belonged to, so a report over a
     * period containing a deleted wallet labels the group by id; that is a
     * display concern, and losing the attribution would be a correctness one.
     */
    walletId: uuid('wallet_id').notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    /** The allocated quantity **after** this change. Zero means "no longer allocated". */
    quantity: quantity('quantity').notNull(),
    /** AR-29: the business date the change takes effect, never a timestamp. */
    effectiveOn: date('effective_on').notNull(),
    /**
     * Why the allocation moved. Not used in the fold — kept because an
     * attribution a user disputes is answered by "a sale on this date reduced
     * it", and reconstructing that from the ledger afterwards is guesswork.
     */
    cause: text('cause').notNull(),
    /** Tie-breaker for two changes on the same business date, and nothing else. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The fold's access path: every event for one tenant up to a date, in order.
    index('wallet_allocation_events_user_id_effective_on_idx').on(table.userId, table.effectiveOn),
    index('wallet_allocation_events_user_id_asset_id_idx').on(table.userId, table.assetId),
    check('wallet_allocation_events_quantity_not_negative_check', sql`${table.quantity} >= 0`),
    check(
      'wallet_allocation_events_cause_check',
      sql`${table.cause} IN ('assignment', 'buy', 'sale', 'corporate_event', 'wallet_deleted', 'backfill')`,
    ),
  ],
);
