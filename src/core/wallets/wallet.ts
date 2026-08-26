import type { UserId, WalletId } from '@/core/shared/ids';
import type { TargetMode } from '@/core/wallets/targets';

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
   * BR-010-02: a stated goal. Descriptive only — never read by any
   * calculation, and still not read by one: SPEC-017's targets are a separate,
   * numeric declaration (`targetMode` below), not an interpretation of this
   * sentence. PRD Q6, which SPEC-010's Out of Scope pointed at, is answered by
   * SPEC-017 DL-017-01.
   */
  readonly goal: string | null;
  readonly color: string | null;
  /**
   * SPEC-017 BR-017-01/02 — whether this wallet declares target allocations,
   * and how. `'none'` for every wallet that has never been given any, which is
   * what makes BR-017-01's "behaves exactly as it does today" the default
   * rather than a special case.
   */
  readonly targetMode: TargetMode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
