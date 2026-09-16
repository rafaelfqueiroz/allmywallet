import type { UserId } from '@/core/shared/ids';
import {
  type CommitBatchInput,
  commitBatch as commitBatchWithWindows,
} from '@/core/ingestion/commit-batch';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { TEST_CORPORATE_EVENT_WINDOWS } from '@/core/ingestion/test-support/build-deps';

/**
 * `commitBatch` with the corporate-event windows at their seeded config values
 * (#113), for the use-case tests that are not about those windows. The handler
 * resolves them from the config registry (SPEC-002); core has no default, so a
 * test that is about them calls the real `commitBatch` with its own.
 */
export function commitBatch(
  deps: IngestionDependencies,
  userId: UserId,
  input: Omit<CommitBatchInput, 'corporateEventWindows'> &
    Partial<Pick<CommitBatchInput, 'corporateEventWindows'>>,
) {
  return commitBatchWithWindows(deps, userId, {
    corporateEventWindows: TEST_CORPORATE_EVENT_WINDOWS,
    ...input,
  } as CommitBatchInput);
}
