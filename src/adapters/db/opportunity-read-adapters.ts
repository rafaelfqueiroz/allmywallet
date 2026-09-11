import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { latestQuotes, priceQuotes } from '@/db/schema/market';
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
  /**
   * `Database | Tx`, the same shape `DrizzleAssetCatalogRepository` takes, and
   * for the same reason: a caller already inside a `withTenant` transaction
   * must be able to hand it *that* transaction rather than have this class
   * reach the pool for a second connection. Neither table below carries RLS
   * (AR-15), so reading them on the caller's transaction costs nothing and
   * avoids the deadlock this seam exists to prevent — with `max: 10` and no
   * `connectionTimeoutMillis` (`src/db/client.ts`), ten concurrent requests
   * each holding a transaction and then asking the pool for an eleventh
   * connection wait forever rather than failing.
   */
  constructor(private readonly db: Database | Tx) {}

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
        tier: 'intraday',
      });
    }

    /*
     * BR-018-02 admits Tesouro Direto, and Tesouro Direto has **no row in
     * `latest_quotes`, ever**: `derivePollingSet` polls only
     * stock/FII/BDR/ETF (SPEC-008 BR-008-11, `core/quotes/polling-set.ts`)
     * and `tesouro.sync` writes the daily file into `price_quotes` instead.
     * Reading only the table above would therefore hand every Tesouro rule a
     * `null` quote for the rest of time — a rule the product offers, accepts,
     * and can never evaluate. That is exactly the failure this spec's own Out
     * of Scope section refuses ("offering one would ship a rule that silently
     * never fires"), and it would be invisible: the badge would just read
     * "sem cotação válida" forever.
     *
     * So a **daily-priced** asset with no intraday quote falls back to its
     * most recent published close — the same row `core/valuation/tesouro.ts`
     * prices the position from, which is what BR-018-14 requires: one stored
     * price, so no two screens can disagree.
     *
     * **The class filter is load-bearing, and an earlier version of this
     * method did not have it.** A bare "no intraday row, but a close exists"
     * test catches far more than Tesouro: a stock added while the budget was
     * exhausted, or one dropped from the polling set after a delisting, has
     * no `latest_quotes` row either. Falling those back to a three-week-old
     * close tagged `daily` handed them a tier `evaluate.ts` times far more
     * leniently, and AC-16 — "an asset whose quote is stale shows the unknown
     * state and sends nothing" — stopped holding for exactly the assets this
     * spec is mostly about. An intraday-priced asset with no intraday quote
     * has no usable price, and `null` is the honest answer for it.
     */
    const missing = [...assetIds].filter((assetId) => !result.has(assetId));
    if (missing.length === 0) return result;

    const closes = await this.db
      .select({
        assetId: priceQuotes.assetId,
        date: priceQuotes.date,
        close: priceQuotes.close,
        source: priceQuotes.source,
        assetClass: assets.assetClass,
      })
      .from(priceQuotes)
      .innerJoin(assets, eq(assets.id, priceQuotes.assetId))
      .where(
        and(
          inArray(priceQuotes.assetId, missing),
          inArray(assets.assetClass, DAILY_PRICED_CLASSES),
        ),
      )
      .orderBy(priceQuotes.assetId, desc(priceQuotes.date));

    for (const row of closes) {
      const assetId = AssetId.of(row.assetId);
      // Ordered newest-first per asset, so the first row seen for an asset is
      // its latest close and every later one is history.
      if (result.has(assetId)) continue;
      result.set(assetId, {
        price: row.close,
        quotedAt: closeInstant(row.date),
        fetchedAt: closeInstant(row.date),
        source: row.source,
        tier: 'daily',
      });
    }
    return result;
  }
}

/**
 * The classes whose only price is a published close. Tesouro Direto is the
 * whole list today: CDB, LCI and LCA have no market price at all (BR-018-02
 * refuses a rule on them outright) and everything else is polled intraday.
 *
 * Spelled out here rather than derived from `isIntradayEligible`'s
 * complement, which would silently enrol CDB/LCI/LCA the day a rule on them
 * became expressible.
 */
const DAILY_PRICED_CLASSES = ['tesouro_direto'] as const;

/**
 * `price_quotes.date` is a business date (AR-29) — the close is *of* that
 * day, with no meaningful time of day — but `StoredQuote` carries instants,
 * so one has to be chosen.
 *
 * **Noon UTC, not midnight.** Midnight UTC is 21:00 of the *previous* day in
 * São Paulo, and every display path formats in São Paulo (`src/i18n/format.ts`),
 * so a close dated 16/03 was rendered to the reader as "15/03 21:00" — on the
 * watch row and inside the email — disagreeing with every other screen that
 * shows the same row's date. Noon is far enough from both boundaries that the
 * instant names the same calendar day in either zone, which is also what lets
 * `evaluate.ts` read the business date back out of it exactly.
 */
function closeInstant(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
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
