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

export function deriveOnboardingStatus(
  _facts: OnboardingFacts,
  _dismissedAt: Date | null,
): OnboardingStatus {
  throw new Error('not implemented');
}
