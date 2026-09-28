import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { priceQuoteGaps } from '@/db/schema/market';
import { positions } from '@/db/schema/positions';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId } from '@/core/shared/ids';
import { CloseGapReason, type CloseGap, type CloseGapRepositoryPort } from '@/core/quotes/ports';

/**
 * SPEC-021 BR-021-31 — `price_quote_gaps`, a shared reference table (AR-15),
 * written with no tenant context by worker-start catch-up.
 */
export class DrizzleCloseGapRepository implements CloseGapRepositoryPort {
  constructor(private readonly db: Database) {}

  async recordGap(gap: CloseGap): Promise<void> {
    await this.db
      .insert(priceQuoteGaps)
      .values({ assetId: gap.assetId, date: gap.date, reason: gap.reason })
      .onConflictDoUpdate({
        target: [priceQuoteGaps.assetId, priceQuoteGaps.date],
        set: { reason: gap.reason, updatedAt: new Date() },
      });
  }

  async clearGap(assetId: AssetId, date: BusinessDate): Promise<void> {
    await this.db
      .delete(priceQuoteGaps)
      .where(and(eq(priceQuoteGaps.assetId, assetId), eq(priceQuoteGaps.date, date)));
  }

  /**
   * #151 — the gaps a later request may still fill, grouped by asset with each
   * asset's dates ascending. `not_supplied` is left out: B3's COTAHIST was read
   * and has no close for that asset that day, so asking again repeats an
   * answer already given (#171; migration 0031 relabelled brapi's own
   * `not_supplied` answers retryable, since COTAHIST's supersede them).
   */
  async listRetryableGaps(): Promise<ReadonlyMap<AssetId, readonly BusinessDate[]>> {
    const rows = await this.db
      .select({ assetId: priceQuoteGaps.assetId, date: priceQuoteGaps.date })
      .from(priceQuoteGaps)
      .where(inArray(priceQuoteGaps.reason, RETRYABLE_GAP_REASONS))
      .orderBy(asc(priceQuoteGaps.assetId), asc(priceQuoteGaps.date));
    const byAsset = new Map<AssetId, BusinessDate[]>();
    for (const row of rows) {
      const assetId = AssetId.of(row.assetId);
      const dates = byAsset.get(assetId) ?? [];
      dates.push(BusinessDate.of(row.date));
      byAsset.set(assetId, dates);
    }
    return byAsset;
  }
}

const RETRYABLE_GAP_REASONS: CloseGapReason[] = [
  CloseGapReason.PROVIDER_UNAVAILABLE,
  CloseGapReason.BUDGET_EXHAUSTED,
];

/**
 * SPEC-021 BR-021-31 — the dates in `[from, to]` a signed-in user's chart
 * marks as gaps: a recorded gap on any asset that user has a position row
 * for.
 *
 * Runs on the caller's **tenant** transaction: `positions` is FORCE-RLS'd, so
 * the sub-select sees only this user's rows, and the gap table itself is
 * shared. `positions` rather than the ledger because reports read derived
 * state, never `transactions` (SPEC-016 BR-016-05). The cost of that choice is
 * stated rather than hidden: a position row carries no history, so a gap on an
 * asset is marked across the whole range, including days before the user
 * bought it or after they sold it to zero. That over-marks a day as "a close
 * was missing" — it never hides a real gap, and never presents a missing
 * close as observed.
 */
export async function listCloseGapDatesForTenant(
  tx: Tx,
  from: BusinessDate,
  to: BusinessDate,
): Promise<readonly BusinessDate[]> {
  const held = tx.select({ assetId: positions.assetId }).from(positions);
  const rows = await tx
    .selectDistinct({ date: priceQuoteGaps.date })
    .from(priceQuoteGaps)
    .where(
      and(
        gte(priceQuoteGaps.date, from),
        lte(priceQuoteGaps.date, to),
        inArray(priceQuoteGaps.assetId, held),
      ),
    )
    .orderBy(asc(priceQuoteGaps.date));
  return rows.map((row) => BusinessDate.of(row.date));
}
