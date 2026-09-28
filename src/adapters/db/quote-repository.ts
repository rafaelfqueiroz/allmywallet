import { and, asc, desc, eq, gte, inArray, lte, max, min, ne, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { latestQuotes, priceQuoteGaps, priceQuotes } from '@/db/schema/market';
import { assets } from '@/db/schema/assets';
import { AssetId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import {
  CloseGapReason,
  type CloseHistoryWriterPort,
  type InsertedCloses,
  type LatestCloseDatePort,
  type LatestQuote,
  type PriceQuote,
  type QuoteRepositoryPort,
  type UnofficialClosesPort,
} from '@/core/quotes/ports';
import type { PriceHistoryPort } from '@/core/valuation/ports';
import type { ClosePriceReader } from '@/core/ingestion/ports';

/** SPEC-008 BR-008-11 — the classes COTAHIST can ever price (`core/quotes/polling-set.ts`'s `INTRADAY_ELIGIBLE_CLASSES`, restated here since `core/` may not be imported for a SQL literal). */
const LISTED_ASSET_CLASSES = ['stock', 'fii', 'bdr', 'etf'] as const;

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
export class DrizzleQuoteRepository
  implements
    QuoteRepositoryPort,
    PriceHistoryPort,
    LatestCloseDatePort,
    ClosePriceReader,
    CloseHistoryWriterPort,
    UnofficialClosesPort
{
  // AR-15: `price_quotes`/`latest_quotes` are shared reference tables with no
  // tenant column (see the class doc above) — `Tx | Database` lets
  // `worker/handlers/import.ts` pass the same tenant transaction the rest of
  // a commit runs on (SPEC-005 BR-005-20d) without a second `withTenant`.
  constructor(private readonly db: Tx | Database) {}

  /**
   * SPEC-021 BR-021-28 — "the last recorded close capture", measured over the
   * assets the caller polls. Restricted to those assets rather than the whole
   * table because `tesouro.sync` writes Tesouro prices here too, on its own
   * schedule: a Tesouro row from this morning must not make yesterday's
   * missed equity close look captured.
   */
  async oldestLastCloseAmong(assetIds: readonly AssetId[]): Promise<BusinessDate | null> {
    if (assetIds.length === 0) return null;
    // #169: each asset's own last close, then the oldest of those — an asset
    // with no close at all has no row here, and so no say in the window.
    const lastByAsset = this.db
      .select({ last: max(priceQuotes.date).as('last') })
      .from(priceQuotes)
      .where(inArray(priceQuotes.assetId, [...assetIds]))
      .groupBy(priceQuotes.assetId)
      .as('last_by_asset');
    const [row] = await this.db.select({ oldest: min(lastByAsset.last) }).from(lastByAsset);
    return row?.oldest ? BusinessDate.of(row.oldest) : null;
  }

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

  /**
   * SPEC-005 BR-005-20d — `ClosePriceReader`. Same query as
   * `getCloseOnOrBefore` above, under the name that port declares; kept as a
   * thin delegation rather than a second implementation so the two callers
   * (SPEC-009's carry-forward and this one) can never read a different close.
   */
  async closeOnOrBefore(
    assetId: AssetId,
    date: BusinessDate,
  ): Promise<{ readonly date: BusinessDate; readonly close: PriceQuote['close'] } | null> {
    return this.getCloseOnOrBefore(assetId, date);
  }

  /**
   * BR-008-09: the official close supersedes the day's intraday quote in
   * history — never a different day's row (the PK is `(asset_id, date)`).
   *
   * SPEC-021 BR-021-31: a close that exists is not a gap. Any gap row for the
   * same `(asset_id, date)` is deleted in the **same transaction**, whichever
   * job wrote the close — `quotes.close-capture`, catch-up or `tesouro.sync` —
   * so no path can leave a chart showing a break on a day that has a real
   * close, and none has to remember to clear it.
   */
  async upsertClosePrice(quote: PriceQuote): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
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
      await tx
        .delete(priceQuoteGaps)
        .where(and(eq(priceQuoteGaps.assetId, quote.assetId), eq(priceQuoteGaps.date, quote.date)));
    });
  }

  /**
   * SPEC-008 BR-008-09/BR-021-31 (#171) — a close COTAHIST no longer supplies
   * for a day must not stay in history (the AC: every close in history equals
   * COTAHIST's `PREULT` for that day). The caller (`syncOfficialCloses`)
   * records the gap separately; deleting here never implies one.
   */
  async deleteClose(assetId: AssetId, date: BusinessDate): Promise<void> {
    await this.db
      .delete(priceQuotes)
      .where(and(eq(priceQuotes.assetId, assetId), eq(priceQuotes.date, date)));
  }

  /**
   * #171 — whether, and since when, `source` has priced the asset: a day an
   * asset COTAHIST has never listed goes unpriced without being a gap
   * (`syncOfficialCloses`).
   */
  async earliestCloseFrom(assetId: AssetId, source: string): Promise<BusinessDate | null> {
    const [row] = await this.db
      .select({ earliest: min(priceQuotes.date) })
      .from(priceQuotes)
      .where(and(eq(priceQuotes.assetId, assetId), eq(priceQuotes.source, source)));
    return row?.earliest ? BusinessDate.of(row.earliest) : null;
  }

  /**
   * SPEC-008 BR-008-09/BR-008-30 (#171) — `UnofficialClosesPort`: every
   * stored listed-asset close not from `officialSource`, any date, any asset
   * (held or not) — `syncOfficialCloses`'s supersede pairs. Listed classes
   * only (BR-008-11): a Tesouro/CDB/LCI/LCA close is never COTAHIST's to
   * supersede.
   */
  async listUnofficialListedCloses(
    officialSource: string,
  ): Promise<
    readonly { readonly assetId: AssetId; readonly code: string; readonly date: BusinessDate }[]
  > {
    const rows = await this.db
      .select({ assetId: priceQuotes.assetId, code: assets.code, date: priceQuotes.date })
      .from(priceQuotes)
      .innerJoin(assets, eq(assets.id, priceQuotes.assetId))
      .where(
        and(
          ne(priceQuotes.source, officialSource),
          inArray(assets.assetClass, [...LISTED_ASSET_CLASSES]),
        ),
      )
      .orderBy(asc(assets.code), asc(priceQuotes.date));
    return rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      code: row.code,
      date: BusinessDate.of(row.date),
    }));
  }

  /**
   * SPEC-008 BR-008-30 (#171) — `UnofficialClosesPort.listRetryableListedGaps`:
   * listed-asset gaps a later request may still fill, any date. Migration 0031
   * relabels every brapi-era `not_supplied` gap this way, so the first run
   * after the upgrade asks COTAHIST for each of those days once.
   */
  async listRetryableListedGaps(): Promise<
    readonly { readonly assetId: AssetId; readonly code: string; readonly date: BusinessDate }[]
  > {
    const rows = await this.db
      .select({ assetId: priceQuoteGaps.assetId, code: assets.code, date: priceQuoteGaps.date })
      .from(priceQuoteGaps)
      .innerJoin(assets, eq(assets.id, priceQuoteGaps.assetId))
      .where(
        and(
          inArray(priceQuoteGaps.reason, [
            CloseGapReason.PROVIDER_UNAVAILABLE,
            CloseGapReason.BUDGET_EXHAUSTED,
          ]),
          inArray(assets.assetClass, [...LISTED_ASSET_CLASSES]),
        ),
      )
      .orderBy(asc(assets.code), asc(priceQuoteGaps.date));
    return rows.map((row) => ({
      assetId: AssetId.of(row.assetId),
      code: row.code,
      date: BusinessDate.of(row.date),
    }));
  }

  /**
   * #161 — `CloseHistoryWriterPort`. `ON CONFLICT DO NOTHING` in chunks, so
   * the whole published history costs one index probe per row and writes only
   * what is missing; one transaction, so a crash leaves either every missing
   * close or none. Gap rows are cleared for every close the offered assets now
   * have, not only the inserted ones — a close stored before a gap was ever
   * recorded is no less a close (BR-021-31).
   */
  async insertMissingCloses(quotes: readonly PriceQuote[]): Promise<InsertedCloses> {
    if (quotes.length === 0) return { inserted: 0, earliest: null };
    const assetIds = [...new Set(quotes.map((quote) => quote.assetId))];
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      let earliest: BusinessDate | null = null;
      for (let start = 0; start < quotes.length; start += INSERT_CHUNK) {
        const rows = await tx
          .insert(priceQuotes)
          .values(
            quotes.slice(start, start + INSERT_CHUNK).map((quote) => ({
              assetId: quote.assetId,
              date: quote.date,
              close: quote.close,
              source: quote.source,
            })),
          )
          .onConflictDoNothing({ target: [priceQuotes.assetId, priceQuotes.date] })
          .returning({ date: priceQuotes.date });
        inserted += rows.length;
        for (const row of rows) {
          const date = BusinessDate.of(row.date);
          if (earliest === null || BusinessDate.isBefore(date, earliest)) earliest = date;
        }
      }
      await tx.execute(sql`
        DELETE FROM ${priceQuoteGaps} g
         USING ${priceQuotes} q
         WHERE g.asset_id = q.asset_id
           AND g.date = q.date
           AND g.asset_id IN (${sql.join(
             assetIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
      `);
      return { inserted, earliest };
    });
  }
}

/** Four parameters a row, well under Postgres's 65 535 bind parameters a statement. */
const INSERT_CHUNK = 2_000;

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
