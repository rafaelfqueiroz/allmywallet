import type { ImportBatchId } from '@/core/shared/ids';
import type { OnboardingFacts } from '@/core/onboarding/ports';

/**
 * SPEC-020 — onboarding status, derived from `OnboardingFacts` and the one
 * persisted dismissal. CONTRACT STUB: signatures are fixed; the body is
 * implemented by the backend dispatch.
 */
export interface OnboardingSteps {
  /** BR-020-03 — ≥ 1 committed import. The only step that gates completion. */
  readonly import: boolean;
  /** No held fixed-income contract lacks a readable rate. Never gates completion (BR-020-17). */
  readonly fixedIncomeRates: boolean;
  /** No unclassified ledger row. Never gates completion (BR-020-17). */
  readonly classification: boolean;
  /** ≥ 1 wallet. Optional, never a gate (BR-020-04). */
  readonly firstWallet: boolean;
}

/**
 * Where the guided sequence (BR-020-04: export → upload → review → commit) stands.
 * - `upload`: nothing staged and nothing committed — export and upload.
 * - `processing`: a batch is `pending`; staging runs on the queue.
 * - `review`: a batch is `previewed`; review and commit on `/import/[batchId]`.
 * - `done`: onboarding is complete.
 */
export type OnboardingStage = 'upload' | 'processing' | 'review' | 'done';

export interface OnboardingStatus {
  readonly complete: boolean;
  readonly steps: OnboardingSteps;
  readonly stage: OnboardingStage;
  /** The staged batch `processing`/`review` point at; `null` otherwise. */
  readonly stagedBatchId: ImportBatchId | null;
  /** BR-020-12 — independent of every step. */
  readonly dismissed: boolean;
  /** BR-020-02 — route to the guide: not complete and not dismissed. */
  readonly shouldGuide: boolean;
}

/**
 * SPEC-020 BR-020-06/07 — every field here is a query result, never a stored
 * flag. BR-020-03: `complete` is gated on `committedImportCount` alone — a
 * user with a stale fixed-income rate or an unclassified row is still done
 * (BR-020-17). BR-020-12: `dismissed` never feeds into `complete` or any
 * `steps` flag — the two are read from entirely disjoint inputs.
 */
export function deriveOnboardingStatus(
  facts: OnboardingFacts,
  dismissedAt: Date | null,
): OnboardingStatus {
  // SPEC-020 BR-020-03: "complete at the first successfully committed
  // import. Nothing else gates completion." Deleting the only import (so the
  // count reverts to 0) reverts this too (BR-020-08) — there is no latch.
  const complete = facts.committedImportCount >= 1;

  const steps: OnboardingSteps = {
    import: complete,
    fixedIncomeRates: facts.contractsMissingRate.length === 0,
    classification: facts.unclassifiedTransactionCount === 0,
    firstWallet: facts.walletCount >= 1,
  };

  // SPEC-020 BR-020-04: export → upload → review → commit.
  const stage: OnboardingStage = complete
    ? 'done'
    : facts.stagedBatch === null
      ? 'upload'
      : facts.stagedBatch.status === 'pending'
        ? 'processing'
        : 'review';

  const stagedBatchId: ImportBatchId | null =
    stage === 'processing' || stage === 'review' ? (facts.stagedBatch?.batchId ?? null) : null;

  // SPEC-020 BR-020-09/12: the one persisted fact, and it never marks a step
  // complete — read here and nowhere near `steps` or `complete` above.
  const dismissed = dismissedAt !== null;

  return {
    complete,
    steps,
    stage,
    stagedBatchId,
    dismissed,
    // SPEC-020 BR-020-02/14: a dismissed guide stays hidden even with no
    // import (BR-020-14) — dismissal alone is enough to stop guiding.
    shouldGuide: !complete && !dismissed,
  };
}
