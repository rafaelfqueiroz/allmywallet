import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import {
  DrizzlePositionQueryRepository,
  DrizzleWalletAllocationRepository,
  DrizzleWalletAssetRuleRepository,
  DrizzleWalletTargetRepository,
  DrizzleWalletRepository,
} from '@/adapters/db/wallet-repository';
import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { db } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * The composition root for `/wallets` (AR-02): the one place that wires
 * `core/wallets`' ports to their Drizzle adapters. Every Server Component and
 * server action under this route goes through `withWalletDeps` rather than
 * constructing a repository itself, which is what keeps AR-11 satisfied
 * (every tenant-scoped query runs inside `withTenant`) without every caller
 * having to remember it.
 */
const clock = new SystemClock();

/**
 * Exported because SPEC-017's balance sweep needs the wallet ports **and** the
 * SPEC-011 report port inside one `withTenant` transaction: the targets and the
 * valuation they are compared against have to come from a single consistent
 * view, or a wallet could be measured against a total that no longer matches
 * the allocations it was computed from.
 */
export function buildWalletDeps(tx: Tx, userId: UserId): WalletDependencies {
  return {
    wallets: new DrizzleWalletRepository(tx, userId),
    allocations: new DrizzleWalletAllocationRepository(tx, userId),
    assetRules: new DrizzleWalletAssetRuleRepository(tx, userId),
    targets: new DrizzleWalletTargetRepository(tx, userId),
    positionQuery: new DrizzlePositionQueryRepository(tx),
    /*
     * AR-15: `assets` is shared reference data with no `user_id` and no RLS
     * policy, so this read needs no tenant context — but it is given the
     * transaction rather than the pool **deliberately**.
     *
     * A caller already inside `withTenant` holds a pooled connection. Asking
     * the pool for a second one to read the catalog means every concurrent
     * request needs two, and once the transactions have taken every connection
     * the catalog reads wait for one that only a transaction can release. That
     * is a deadlock, it appears only under concurrency, and it looks exactly
     * like a slow database.
     */
    assetCatalog: new DrizzleAssetCatalogRepository(tx),
    clock,
  };
}

export async function withWalletDeps<T>(
  userId: UserId,
  fn: (deps: WalletDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildWalletDeps(tx, userId)), db);
}
