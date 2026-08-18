import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import type { UserId } from '@/core/shared/ids';
import type { TransactionRepository } from '@/core/ledger/ports';
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
