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
   * BR-010-02: the wallet's stated purpose, in the user's own words.
   *
   * **No longer the whole story.** SPEC-019 promotes BR-010-02 from
   * descriptive to calculated (DL-019-06): a wallet's *measured* goals are
   * rows in `wallet_goals`, each with an amount, a kind and a progress figure
   * — `core/goals/`. This column stays as the sentence it always was, and the
   * goals page offers it as the name of a first goal rather than duplicating
   * it. Two fields both called "goal" on one wallet, one of them decorative,
   * is the trap DL-019-06 exists to avoid; keeping this one as *the purpose*
   * and putting the numbers next door is how that is avoided.
   *
   * Still read by no calculation. SPEC-017's targets (`targetMode` below) are
   * a separate numeric declaration, not an interpretation of this sentence,
   * and neither is a SPEC-019 goal. PRD Q6, which SPEC-010's Out of Scope
   * pointed at, is answered by SPEC-017 DL-017-01.
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
