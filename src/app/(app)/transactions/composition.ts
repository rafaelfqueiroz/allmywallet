import {
  DrizzleAssetResolver,
  DrizzleInstitutionResolver,
} from '@/adapters/db/ingestion-resolvers';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzlePositionRepository } from '@/adapters/db/position-repository';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { AssetResolverPort, InstitutionResolverPort } from '@/core/ingestion/ports';
import type { LedgerDependencies } from '@/core/ledger/dependencies';
import type { TransactionRepository } from '@/core/ledger/ports';
import type { AssignTransactionsDependencies } from '@/core/wallets/assign-transactions';
import {
  DrizzlePositionQueryRepository,
  DrizzleWalletAllocationRepository,
  DrizzleWalletAssetRuleRepository,
  DrizzleWalletTargetRepository,
  DrizzleWalletRepository,
} from '@/adapters/db/wallet-repository';
import { db } from '@/db/client';
import { withTenant, type Tx } from '@/db/tenant';

/**
 * The composition root for `/transactions` (AR-02): the one place that wires
 * `core/ledger`'s `TransactionRepository` port to its Drizzle adapter, so
 * every Server Component and route handler under this surface goes through
 * `withTransactionsDeps` rather than constructing a repository itself — which
 * is what keeps AR-11 satisfied (every tenant-scoped query runs inside
 * `withTenant`) without every caller having to remember it. Mirrors
 * `(app)/wallets/composition.ts`.
 *
 * `fn` also receives the raw `Tx`: `data.ts`'s filter-option queries
 * (`listAssetOptions`) need it directly, and this is what lets the page load
 * the transaction page **and** its filter options from one tenant transaction
 * rather than opening `withTenant` twice per request.
 */
export interface TransactionsDeps {
  readonly transactions: TransactionRepository;
}

function buildDeps(tx: Tx, userId: UserId): TransactionsDeps {
  return { transactions: new DrizzleTransactionRepository(tx, userId) };
}

export async function withTransactionsDeps<T>(
  userId: UserId,
  fn: (deps: TransactionsDeps, tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildDeps(tx, userId), tx), db);
}

/**
 * The write side of the same surface (BR-006-11..17). One `withTenant`
 * transaction carries all three port groups on purpose:
 *
 *  - `ledger` writes the row and recalculates the position forward;
 *  - `wallets` follows the position — `applyLedgerEffects` for a row that
 *    arrived, `reconcileAllocationsToHoldings` for one that changed or left.
 *    Two transactions would let the ledger write commit while the allocation
 *    adjustment rolled back, leaving BR-010-05's sum invariant broken with no
 *    retry that repairs it (the reason `worker/handlers/import.ts` states for
 *    doing the same);
 *  - `assets`/`institutions` resolve the free-text code and name a manual
 *    entry may carry for something no B3 extract has ever mentioned — the
 *    spec's "a CDB absent from every B3 extract" criterion. They are the
 *    same resolvers SPEC-005's commit uses, so a manually entered PETR4 and
 *    an imported one land on one catalogue row rather than two.
 */
export interface TransactionWriteDeps {
  readonly ledger: LedgerDependencies;
  readonly assign: AssignTransactionsDependencies;
  readonly assets: AssetResolverPort;
  readonly institutions: InstitutionResolverPort;
}

const clock = new SystemClock();

export async function withTransactionWriteDeps<T>(
  userId: UserId,
  fn: (deps: TransactionWriteDeps) => Promise<T>,
): Promise<T> {
  return withTenant(
    userId,
    (tx) => {
      const transactions = new DrizzleTransactionRepository(tx, userId);
      /**
       * The four wallet ports are wired here rather than through
       * `worker/handlers/import.ts`'s `buildWalletDeps`, which `(app)/import`
       * reuses: that module also pulls in the xlsx parser and the queue
       * client, and importing it from this surface put `pg-boss` in the
       * dependency graph of the CSV export route. Same four adapters as
       * `(app)/wallets/composition.ts`, which is the shape this follows.
       */
      const wallets = {
        wallets: new DrizzleWalletRepository(tx, userId),
        allocations: new DrizzleWalletAllocationRepository(tx, userId),
        assetRules: new DrizzleWalletAssetRuleRepository(tx, userId),
        targets: new DrizzleWalletTargetRepository(tx, userId),
        positionQuery: new DrizzlePositionQueryRepository(tx),
        assetCatalog: new DrizzleAssetCatalogRepository(tx),
        clock,
      };
      return fn({
        ledger: {
          transactions,
          positions: new DrizzlePositionRepository(tx, userId),
          clock,
        },
        assign: { ...wallets, transactions },
        assets: new DrizzleAssetResolver(tx),
        institutions: new DrizzleInstitutionResolver(tx),
      });
    },
    db,
  );
}
