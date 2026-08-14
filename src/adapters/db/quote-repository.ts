import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { latestQuotes, priceQuotes } from '@/db/schema/market';
import { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import type { LatestQuote, PriceQuote, QuoteRepositoryPort } from '@/core/quotes/ports';
import type { PriceHistoryPort } from '@/core/valuation/ports';

/**
 * SPEC-008 BR-008-10 — the two tables below are queried and written
 * independently, on purpose: nothing in this class can make an intraday
 * write touch `price_quotes`, or a close-price write touch `latest_quotes`.
 * Both are shared reference tables (AR-15/BR-003-06); no `withTenant`.
 *
 * It also satisfies SPEC-009's `PriceHistoryPort` — the read side valuation
 * needs. One class rather than two because the underlying tables are the same
 * and a second adapter would only add a way for the two to disagree about
 * what "the close" means; the ports stay separate so `core/valuation` depends
 * on the two methods it uses rather than on the write surface it must not.
 */
export class DrizzleQuoteRepository implements QuoteRepositoryPort, PriceHistoryPort {
  constructor(private readonly db: Database) {}

  async getLatestQuote(assetId: AssetId): Promise<LatestQuote | null> {
    const [row] = await this.db
      .select()
      .from(latestQuotes)
      .where(eq(latestQuotes.assetId, assetId));
    return row ? toLatestQuote(row) : null;
  }

  async upsertLatestQuote(quote: LatestQuote): Promise<void> {
    await this.db
      .insert(latestQuotes)
      .values({
        assetId: quote.assetId,
        price: quote.price,
        quotedAt: quote.quotedAt,
        fetchedAt: quote.fetchedAt,
        source: quote.source,
      })
      .onConflictDoUpdate({
        target: latestQuotes.assetId,
        set: {
          price: quote.price,
          quotedAt: quote.quotedAt,
          fetchedAt: quote.fetchedAt,
          source: quote.source,
          updatedAt: new Date(),
        },
      });
  }

  async getClosePrice(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null> {
    const [row] = await this.db
      .select()
      .from(priceQuotes)
      .where(and(eq(priceQuotes.assetId, assetId), eq(priceQuotes.date, date)));
    return row ? toPriceQuote(row) : null;
  }

  /**
   * SPEC-009 BR-009-03 — the carry-forward lookup: the most recent close at
   * or before `date`. Returns the row **with its own date**, which is what
   * lets the caller say a price was carried forward instead of passing a
   * stale figure off as the day's own.
   */
  async getCloseOnOrBefore(assetId: AssetId, date: BusinessDate): Promise<PriceQuote | null> {
    const [row] = await this.db
      .select()
      .from(priceQuotes)
      .where(and(eq(priceQuotes.assetId, assetId), lte(priceQuotes.date, date)))
      .orderBy(desc(priceQuotes.date))
      .limit(1);
    return row ? toPriceQuote(row) : null;
  }

  /**
   * SPEC-009 — every close in `[from, to]`, ascending. A snapshot rebuild
   * covers years of dates; asking per date would be one query per asset per
   * day. Paired with a single `getCloseOnOrBefore(asset, from)` anchor, this
   * is the whole price history a rebuild needs, in two queries per asset.
   */
  async listCloses(
    assetId: AssetId,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly PriceQuote[]> {
    const rows = await this.db
      .select()
      .from(priceQuotes)
      .where(
        and(
          eq(priceQuotes.assetId, assetId),
          gte(priceQuotes.date, from),
          lte(priceQuotes.date, to),
        ),
      )
      .orderBy(asc(priceQuotes.date));
    return rows.map(toPriceQuote);
  }

  /** BR-008-09: the official close supersedes the day's intraday quote in history — never a different day's row (the PK is `(asset_id, date)`). */
  async upsertClosePrice(quote: PriceQuote): Promise<void> {
    await this.db
      .insert(priceQuotes)
      .values({
        assetId: quote.assetId,
        date: quote.date,
        close: quote.close,
        source: quote.source,
      })
      .onConflictDoUpdate({
        target: [priceQuotes.assetId, priceQuotes.date],
        set: { close: quote.close, source: quote.source, updatedAt: new Date() },
      });
  }
}

// AR-06/AR-07: the `money` custom type (src/db/numeric.ts) already parses
// NUMERIC -> Money at the driver boundary via `Money.fromString`, so `row.price`
// / `row.close` below are already `Money` — never re-parsed through `Number()`.
function toLatestQuote(row: typeof latestQuotes.$inferSelect): LatestQuote {
  return {
    assetId: AssetId.of(row.assetId),
    price: row.price,
    quotedAt: row.quotedAt,
    fetchedAt: row.fetchedAt,
    source: row.source,
  };
}

function toPriceQuote(row: typeof priceQuotes.$inferSelect): PriceQuote {
  return {
    assetId: AssetId.of(row.assetId),
    date: BusinessDate.of(row.date),
    close: row.close,
    source: row.source,
  };
}
