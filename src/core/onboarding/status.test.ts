import { describe, expect, it } from 'vitest';
import { AssetId, ImportBatchId } from '@/core/shared/ids';
import type { OnboardingFacts } from '@/core/onboarding/ports';
import { deriveOnboardingStatus } from '@/core/onboarding/status';

/**
 * SPEC-020 BR-020-03/06..14 — onboarding status, derived entirely from
 * `OnboardingFacts` and the one persisted dismissal. TS-01: no database —
 * every fixture below is a hand-built `OnboardingFacts`.
 */

const BATCH = ImportBatchId.of('01920000-0000-7000-8000-0000000000f1');
const CDB = AssetId.of('01920000-0000-7000-8000-0000000000a1');

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    committedImportCount: 0,
    contractsMissingRate: [],
    unclassifiedTransactionCount: 0,
    walletCount: 0,
    stagedBatch: null,
    ...overrides,
  };
}

describe('completion (BR-020-03)', () => {
  it('is incomplete with no committed import', () => {
    expect(deriveOnboardingStatus(facts(), null).complete).toBe(false);
  });

  it('is complete at exactly one committed import', () => {
    const status = deriveOnboardingStatus(facts({ committedImportCount: 1 }), null);
    expect(status.complete).toBe(true);
    expect(status.steps.import).toBe(true);
  });

  it('is complete with more than one committed import', () => {
    expect(deriveOnboardingStatus(facts({ committedImportCount: 5 }), null).complete).toBe(true);
  });

  /**
   * BR-020-08 — "deleting the only import makes onboarding incomplete
   * again". Derived state is never latched: two independent calls with the
   * count crossing 1 → 0 must disagree, exactly as two reads against a real
   * database would after the row was deleted.
   */
  it('reverts to incomplete when the committed count drops back to zero', () => {
    const before = deriveOnboardingStatus(facts({ committedImportCount: 1 }), null);
    const after = deriveOnboardingStatus(facts({ committedImportCount: 0 }), null);
    expect(before.complete).toBe(true);
    expect(after.complete).toBe(false);
  });

  /**
   * BR-020-17 — "gates are not part of onboarding completion... that is not
   * a failed onboarding." A committed import alone is enough, no matter how
   * many other steps are unmet.
   */
  it('is complete even with every other gate unmet', () => {
    const status = deriveOnboardingStatus(
      facts({
        committedImportCount: 1,
        contractsMissingRate: [{ assetId: CDB }],
        unclassifiedTransactionCount: 3,
        walletCount: 0,
      }),
      null,
    );
    expect(status.complete).toBe(true);
    expect(status.steps).toEqual({
      import: true,
      fixedIncomeRates: false,
      classification: false,
      firstWallet: false,
    });
  });
});

describe('steps (BR-020-07)', () => {
  it('marks fixedIncomeRates true only when nothing is missing a rate', () => {
    expect(deriveOnboardingStatus(facts(), null).steps.fixedIncomeRates).toBe(true);
    expect(
      deriveOnboardingStatus(facts({ contractsMissingRate: [{ assetId: CDB }] }), null).steps
        .fixedIncomeRates,
    ).toBe(false);
  });

  it('marks classification true only when nothing is unclassified', () => {
    expect(deriveOnboardingStatus(facts(), null).steps.classification).toBe(true);
    expect(
      deriveOnboardingStatus(facts({ unclassifiedTransactionCount: 1 }), null).steps
        .classification,
    ).toBe(false);
  });

  it('marks firstWallet true once at least one wallet exists', () => {
    expect(deriveOnboardingStatus(facts(), null).steps.firstWallet).toBe(false);
    expect(deriveOnboardingStatus(facts({ walletCount: 1 }), null).steps.firstWallet).toBe(true);
  });
});

describe('stage (BR-020-04)', () => {
  it('is upload when nothing is staged and nothing committed', () => {
    expect(deriveOnboardingStatus(facts(), null).stage).toBe('upload');
  });

  it('is processing while the newest staged batch is pending', () => {
    const status = deriveOnboardingStatus(
      facts({ stagedBatch: { batchId: BATCH, status: 'pending' } }),
      null,
    );
    expect(status.stage).toBe('processing');
    expect(status.stagedBatchId).toBe(BATCH);
  });

  it('is review once the staged batch has been previewed', () => {
    const status = deriveOnboardingStatus(
      facts({ stagedBatch: { batchId: BATCH, status: 'previewed' } }),
      null,
    );
    expect(status.stage).toBe('review');
    expect(status.stagedBatchId).toBe(BATCH);
  });

  it('is done once complete, regardless of any staged batch', () => {
    const status = deriveOnboardingStatus(
      facts({ committedImportCount: 1, stagedBatch: { batchId: BATCH, status: 'previewed' } }),
      null,
    );
    expect(status.stage).toBe('done');
  });

  it('carries no staged batch id in upload or done', () => {
    expect(deriveOnboardingStatus(facts(), null).stagedBatchId).toBeNull();
    expect(
      deriveOnboardingStatus(facts({ committedImportCount: 1 }), null).stagedBatchId,
    ).toBeNull();
  });
});

describe('dismissal (BR-020-09/12/13)', () => {
  it('reads dismissed from a non-null timestamp', () => {
    expect(deriveOnboardingStatus(facts(), new Date('2026-03-01T00:00:00Z')).dismissed).toBe(
      true,
    );
  });

  it('reads not dismissed from null', () => {
    expect(deriveOnboardingStatus(facts(), null).dismissed).toBe(false);
  });

  /**
   * BR-020-12 — "dismissal hides the guide. It never marks a step complete —
   * the two are independent." A dismissed guide with no import at all must
   * still read every step false and `complete` false.
   */
  it('never marks a step or completion true by itself', () => {
    const status = deriveOnboardingStatus(facts(), new Date('2026-03-01T00:00:00Z'));
    expect(status.complete).toBe(false);
    expect(status.steps).toEqual({
      import: false,
      fixedIncomeRates: true,
      classification: true,
      firstWallet: false,
    });
  });

  it('does not affect completion when an import already exists', () => {
    const status = deriveOnboardingStatus(
      facts({ committedImportCount: 1 }),
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(status.complete).toBe(true);
    expect(status.dismissed).toBe(true);
  });
});

describe('shouldGuide (BR-020-02/14)', () => {
  it('guides a fresh, undismissed user', () => {
    expect(deriveOnboardingStatus(facts(), null).shouldGuide).toBe(true);
  });

  it('does not guide once complete, dismissed or not', () => {
    expect(
      deriveOnboardingStatus(facts({ committedImportCount: 1 }), null).shouldGuide,
    ).toBe(false);
    expect(
      deriveOnboardingStatus(facts({ committedImportCount: 1 }), new Date('2026-03-01T00:00:00Z'))
        .shouldGuide,
    ).toBe(false);
  });

  /** BR-020-14 — a dismissed guide with no import stays hidden, not re-shown. */
  it('does not guide a dismissed, still-incomplete user', () => {
    expect(
      deriveOnboardingStatus(facts(), new Date('2026-03-01T00:00:00Z')).shouldGuide,
    ).toBe(false);
  });
});
