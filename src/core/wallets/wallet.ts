import type { UserId, WalletId } from '@/core/shared/ids';

/**
 * SPEC-010 — a wallet is a purpose-based grouping that cuts across brokers and
 * asset classes (BR-010-01). It never duplicates a transaction (BR-010-08):
 * everything here is metadata about the grouping itself, not a ledger.
 */
export interface Wallet {
  readonly id: WalletId;
  readonly userId: UserId;
  readonly name: string;
  readonly description: string | null;
  /**
   * BR-010-02: a stated goal. Descriptive only in v1 — never read by any
   * calculation. Out of Scope explicitly excludes target allocations,
   * rebalancing or "will I reach my number" projections (PRD Q6).
   */
  readonly goal: string | null;
  readonly color: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
