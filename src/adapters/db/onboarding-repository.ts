import { and, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import { fixedIncomeContracts } from '@/db/schema/import-rows';
import { positions } from '@/db/schema/positions';
import { importBatches, transactions } from '@/db/schema/transactions';
import { users } from '@/db/schema/users';
import { wallets } from '@/db/schema/wallets';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { UserId } from '@/core/shared/ids';
import type {
  ContractMissingRate,
  OnboardingDismissalPort,
  OnboardingFacts,
  OnboardingFactsPort,
  StagedBatch,
} from '@/core/onboarding/ports';

/**
 * SPEC-020 BR-020-06/07 — every onboarding "fact" is a **count**, not a row
 * load: the dashboard that reads through `loadOnboardingStatus` carries the
 * same 2s p95 budget as everything else on that screen (SPEC-016 BR-016-02),
 * and BR-020-10 forbids a stored progress table that would make counting
 * unnecessary. Five independent reads, run in parallel — none depends on
 * another's result.
 *
 * AR-11: every query here runs on a `Tx` obtained from `withTenant`; the
 * tenant filter is not written into the WHERE clauses, RLS applies it (the
 * same convention `DrizzleImportBatchRepository` and its neighbours use).
 */
export class DrizzleOnboardingFactsRepository implements OnboardingFactsPort {
  constructor(private readonly tx: Tx) {}

  async readFacts(): Promise<OnboardingFacts> {
    const [committedRows, contractRows, unclassifiedRows, walletRows, stagedRows] =
      await Promise.all([
        // BR-020-03/07: "at least one committed import batch."
        this.tx
          .select({ count: sql<number>`count(*)::int` })
          .from(importBatches)
          .where(eq(importBatches.status, 'committed')),

        /**
         * BR-020-07: "any fixed-income contract with no contracted rate."
         *
         * Narrowed to contracts for an asset **currently held** — an `exists`
         * against `positions.quantity > 0` — which the issue's plan did not
         * name. A sold CDB has no bearing on today's portfolio value, so a
         * stale contract row for it cannot understate anything on screen;
         * counting it anyway would put a permanent, unresolvable gate in the
         * queue for a holding that no longer exists. This is a deliberate
         * reading of BR-020-07 (see the dispatch report's Decision log), not
         * a widening of what the rule already says the dashboard is for
         * (BR-020-19's "cannot be valued" only applies to what is valued at
         * all).
         */
        this.tx
          .select({ assetId: fixedIncomeContracts.assetId })
          .from(fixedIncomeContracts)
          .where(
            and(
              or(isNull(fixedIncomeContracts.indexer), isNull(fixedIncomeContracts.rate)),
              exists(
                this.tx
                  .select({ one: sql`1` })
                  .from(positions)
                  .where(
                    and(
                      eq(positions.assetId, fixedIncomeContracts.assetId),
                      sql`${positions.quantity} > 0`,
                    ),
                  ),
              ),
            ),
          ),

        // BR-020-07/SPEC-006 DL-006-06: "any transaction with an unclassified
        // movement type" is `transactions.status = 'unclassified'`.
        this.tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(eq(transactions.status, 'unclassified')),

        // BR-020-07: "at least one wallet."
        this.tx.select({ count: sql<number>`count(*)::int` }).from(wallets),

        // BR-020-04: the batch the guided sequence's "review"/"processing"
        // stage points at — the newest still-open one.
        this.tx
          .select({ id: importBatches.id, status: importBatches.status })
          .from(importBatches)
          .where(inArray(importBatches.status, ['pending', 'previewed']))
          .orderBy(desc(importBatches.uploadedAt))
          .limit(1),
      ]);

    const contractsMissingRate: readonly ContractMissingRate[] = contractRows.map((row) => ({
      assetId: AssetId.of(row.assetId),
    }));

    const staged = stagedRows[0];
    const stagedBatch: StagedBatch | null =
      staged === undefined
        ? null
        : {
            batchId: ImportBatchId.of(staged.id),
            // `import_batches_status_check` restricts this column to the five
            // known values; the WHERE clause above already narrows it to
            // exactly these two.
            status: staged.status as 'pending' | 'previewed',
          };

    return {
      committedImportCount: committedRows[0]?.count ?? 0,
      contractsMissingRate,
      unclassifiedTransactionCount: unclassifiedRows[0]?.count ?? 0,
      walletCount: walletRows[0]?.count ?? 0,
      stagedBatch,
    };
  }
}

/**
 * SPEC-020 BR-020-09 — `users.onboarding_dismissed_at`.
 *
 * `users` is the tenant root and is not RLS-scoped (see the comment on the
 * table itself, and `DrizzleUserRepository`, which queries it the same way),
 * so every statement here is filtered explicitly on `id = userId` rather than
 * relying on a policy that does not exist for this table.
 */
export class DrizzleOnboardingDismissalRepository implements OnboardingDismissalPort {
  constructor(private readonly db: Database) {}

  async dismissedAt(userId: UserId): Promise<Date | null> {
    const [row] = await this.db
      .select({ onboardingDismissedAt: users.onboardingDismissedAt })
      .from(users)
      .where(eq(users.id, userId));
    return row?.onboardingDismissedAt ?? null;
  }

  async setDismissedAt(userId: UserId, at: Date | null): Promise<void> {
    await this.db
      .update(users)
      .set({ onboardingDismissedAt: at, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }
}
