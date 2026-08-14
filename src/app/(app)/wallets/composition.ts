import {
  DrizzlePositionQueryRepository,
  DrizzleWalletAllocationRepository,
  DrizzleWalletAssetRuleRepository,
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

function buildDeps(tx: Tx, userId: UserId): WalletDependencies {
  return {
    wallets: new DrizzleWalletRepository(tx, userId),
    allocations: new DrizzleWalletAllocationRepository(tx, userId),
    assetRules: new DrizzleWalletAssetRuleRepository(tx, userId),
    positionQuery: new DrizzlePositionQueryRepository(tx),
    clock,
  };
}

export async function withWalletDeps<T>(
  userId: UserId,
  fn: (deps: WalletDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildDeps(tx, userId)), db);
}
