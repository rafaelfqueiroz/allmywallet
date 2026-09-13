import type { AssetId, ImportBatchId, UserId } from '@/core/shared/ids';

/**
 * SPEC-020 — the read and write seams onboarding needs, and nothing more.
 *
 * **Progress is derived, not stored** (BR-020-06, DL-020-03). `OnboardingFacts`
 * is a set of counts over data that already exists for other reasons; there is
 * no onboarding table behind it and there must never be one (BR-020-10). A
 * future step that seems to need a flag needs another field here instead.
 */

/**
 * A fixed-income contract whose indexer or contracted rate could not be read
 * (SPEC-009 BR-009-13), for an asset that is not a closed position.
 */
export interface ContractMissingRate {
  readonly assetId: AssetId;
  /** From the asset catalogue — the holding set cannot label an asset that is not held. */
  readonly assetCode: string;
  /**
   * `true` when an open position exists, so the contract sits at cost inside
   * the total. `false` when no position exists at all: a Posição committed
   * before the Movimentação carrying the application (BR-020-22's "any
   * order"), so the asset is absent from the total, not merely valued at cost.
   */
  readonly held: boolean;
}

/** A batch uploaded but not yet committed — where the guided flow's "review" and "commit" steps point. */
export interface StagedBatch {
  readonly batchId: ImportBatchId;
  readonly status: 'pending' | 'previewed';
}

/** BR-020-07's four queries, plus the staged batch the guide links to. Every field is a query result. */
export interface OnboardingFacts {
  /** Committed import batches. ≥ 1 is onboarding completion (BR-020-03). */
  readonly committedImportCount: number;
  /** Held contracts with no readable indexer or rate. */
  readonly contractsMissingRate: readonly ContractMissingRate[];
  /** Ledger rows stored with `status = 'unclassified'` (SPEC-006 DL-006-06). */
  readonly unclassifiedTransactionCount: number;
  readonly walletCount: number;
  /** The most recently uploaded batch still `pending` or `previewed`; `null` when none. */
  readonly stagedBatch: StagedBatch | null;
}

export interface OnboardingFactsPort {
  /** Tenant-scoped: runs inside `withTenant` (AR-11). */
  readFacts(): Promise<OnboardingFacts>;
}

/**
 * BR-020-09 — `users.onboarding_dismissed_at`. `users` is the tenant root and
 * is not RLS-scoped, so the adapter must key every read and write on the
 * session's own `userId` and nothing else (AR-12).
 */
export interface OnboardingDismissalPort {
  dismissedAt(userId: UserId): Promise<Date | null>;
  setDismissedAt(userId: UserId, at: Date | null): Promise<void>;
}
