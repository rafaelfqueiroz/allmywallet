import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { indexSeries } from '@/db/schema/market';
import { BusinessDate } from '@/core/shared/clock';
import type {
  IndexSeriesCode,
  IndexSeriesPointRecord,
  IndexSeriesRepositoryPort,
} from '@/core/quotes/ports';
import type { IndexSeriesPoint, IndexSeriesReaderPort } from '@/core/valuation/ports';

/**
 * SPEC-008 — CDI/IPCA/Selic/IBOV history. Shared reference table; no
 * `withTenant`.
 *
 * Also satisfies SPEC-009's `IndexSeriesReaderPort`: SPEC-008 only ever
 * needed to know the *latest* stored date (to fetch incrementally), while
 * accrual needs to read the points themselves. Two ports, one table, one
 * adapter — `core/valuation` depends only on the read method it uses.
 */
export class DrizzleIndexSeriesRepository
  implements IndexSeriesRepositoryPort, IndexSeriesReaderPort
{
  constructor(private readonly db: Database) {}

  /**
   * SPEC-009 BR-009-08/10 — the published points in `[from, to]`, ascending.
   * Inclusive of both ends: `from` is the instrument's issue date, whose own
   * CDI is the first day that compounds.
   */
  async listPoints(
    code: IndexSeriesCode,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly IndexSeriesPoint[]> {
    const rows = await this.db
      .select({ date: indexSeries.date, value: indexSeries.value })
      .from(indexSeries)
      .where(
        and(eq(indexSeries.code, code), gte(indexSeries.date, from), lte(indexSeries.date, to)),
      )
      .orderBy(asc(indexSeries.date));
    // AR-06/AR-07: `rate` is the NUMERIC custom type, so `row.value` is
    // already a `Quantity` — never re-parsed through `Number()`.
    return rows.map((row) => ({ date: BusinessDate.of(row.date), value: row.value }));
  }

  async latestDate(code: IndexSeriesCode): Promise<BusinessDate | null> {
    const [row] = await this.db
      .select({ date: indexSeries.date })
      .from(indexSeries)
      .where(eq(indexSeries.code, code))
      .orderBy(desc(indexSeries.date))
      .limit(1);
    return row ? BusinessDate.of(row.date) : null;
  }

  async upsertPoints(points: readonly IndexSeriesPointRecord[]): Promise<void> {
    for (const point of points) {
      await this.db
        .insert(indexSeries)
        .values({ code: point.code, date: point.date, value: point.value, source: point.source })
        .onConflictDoUpdate({
          target: [indexSeries.code, indexSeries.date],
          set: { value: point.value, source: point.source },
        });
    }
  }
}
