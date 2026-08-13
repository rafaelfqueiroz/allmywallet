import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { latestQuotes, priceQuotes } from '@/db/schema/market';
import { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import type { LatestQuote, PriceQuote, QuoteRepositoryPort } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-10 — the two tables below are queried and written
 * independently, on purpose: nothing in this class can make an intraday
 * write touch `price_quotes`, or a close-price write touch `latest_quotes`.
 * Both are shared reference tables (AR-15/BR-003-06); no `withTenant`.
 */
export class DrizzleQuoteRepository implements QuoteRepositoryPort {
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
