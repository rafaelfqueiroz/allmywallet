import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { latestQuotes } from '@/db/schema/market';
import { positions } from '@/db/schema/positions';
import { assets } from '@/db/schema/assets';
import { AssetId, type UserId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import type { AssetClass } from '@/core/quotes/ports';
import type { HeldAssetReader, StoredQuote, StoredQuoteReader } from '@/core/opportunity/ports';

/**
 * SPEC-018 — the two read-only ports `core/opportunity` needs, over tables
 * SPEC-007/SPEC-008 already own. Neither writes anything; both exist because
 * `core/opportunity` may not reach `src/db` directly (AR-01).
 */

/**
 * BR-018-11/14 — reads `latest_quotes`, the exact shared table (AR-15) every
 * other screen's current price comes from. No `withTenant`: there is no
 * tenant column to scope by. And, the whole point of this port's own doc
 * comment in `core/opportunity/ports.ts`, no path from here to a provider —
 * this class can only read what SPEC-008 has already written.
 */
export class DrizzleStoredQuoteReader implements StoredQuoteReader {
  constructor(private readonly db: Database) {}

  async latestFor(assetIds: readonly AssetId[]): Promise<ReadonlyMap<AssetId, StoredQuote>> {
    if (assetIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(latestQuotes)
      .where(inArray(latestQuotes.assetId, [...assetIds]));

    const result = new Map<AssetId, StoredQuote>();
    for (const row of rows) {
      result.set(AssetId.of(row.assetId), {
        price: row.price,
        quotedAt: row.quotedAt,
        fetchedAt: row.fetchedAt,
        source: row.source,
      });
    }
    return result;
  }
}

/**
 * BR-018-01 — "an asset the user currently holds in a non-zero position."
 *
 * `positions` carries one row per `(user, asset, institution)`
 * (`positions_user_asset_institution_key`), so a holding split across two
 * institutions is two rows sharing one `asset_id`. This aggregates them with
 * `SUM(quantity)` rather than returning one row per institution, because
 * BR-018-01 is a statement about the asset — "an asset the user holds" — not
 * about any single institution's slice of it; a rule watching PETR4 should
 * not depend on which institution happened to be read first.
 * `positions.quantity >= 0` always holds (its own CHECK,
 * `positions_quantity_non_negative_check`), so summing across institutions
 * can never let a closed position at one broker cancel out a real holding at
 * another.
 *
 * Tenant-scoped (AR-11): constructed from a `Tx` already inside `withTenant`,
 * the same shape as `DrizzleWalletGoalRepository`.
 */
export class DrizzleHeldAssetReader implements HeldAssetReader {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async listHeld(): Promise<
    readonly { assetId: AssetId; assetClass: AssetClass; quantity: Quantity }[]
  > {
    const rows = await this.tx
      .select({
        assetId: positions.assetId,
        assetClass: assets.assetClass,
        // A raw aggregate: `positions.quantity`'s custom type (src/db/numeric.ts)
        // parses a plain column read into `Quantity`, but `SUM(...)` is a
        // computed expression the customType machinery does not touch — the
        // driver still hands back a NUMERIC as a string, parsed explicitly
        // below via `Quantity.fromString` (AR-06/AR-07: never through `Number()`).
        quantity: sql<string>`sum(${positions.quantity})`,
      })
      .from(positions)
      .innerJoin(assets, eq(positions.assetId, assets.id))
      .groupBy(positions.assetId, assets.assetClass);

    return rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      // `assets_class_check` restricts the column to exactly the eight
      // members of `AssetClass` — the same cast `DrizzleAssetCatalogRepository`
      // makes, on the same guarantee.
      assetClass: row.assetClass as AssetClass,
      quantity: Quantity.fromString(row.quantity),
    }));
  }
}
