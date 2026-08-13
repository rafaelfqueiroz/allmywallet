import type { AssetId } from '@/core/shared/ids';
import type { HeldAssetsPort } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-08 — "the polling set is derived, not configured: exactly
 * the distinct assets in at least one user's non-zero position."
 *
 * DEVIATION (flagged for the dispatch report and the issue's Decision log,
 * not a silent stub): this task (#11) landed on a branch where the ledger
 * and positions tables (SPEC-006/007) do not exist yet. There is nothing in
 * the schema today a `SELECT DISTINCT asset_id FROM positions WHERE
 * quantity <> 0` could run against. `computePollingSet`
 * (`core/quotes/polling-set.ts`) and every worker handler in this directory
 * are written against `HeldAssetsPort` and fully exercised in tests via
 * `FakeHeldAssetsPort` — the seam is real and in place. This class is the
 * one placeholder implementation: it returns an empty set, which is the
 * **honest** answer given the ledger does not exist ("nobody holds
 * anything" is true, not approximated). When SPEC-006/007 lands, replace
 * this file's body with the real query and nothing else in `core/` or the
 * handlers needs to change.
 */
export class NoLedgerHeldAssetsRepository implements HeldAssetsPort {
  async listDistinctHeldAssetIds(): Promise<readonly AssetId[]> {
    return [];
  }
}
