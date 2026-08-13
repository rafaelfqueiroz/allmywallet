import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { indexSeries } from '@/db/schema/market';
import { BusinessDate } from '@/core/shared/clock';
import type {
  IndexSeriesCode,
  IndexSeriesPointRecord,
  IndexSeriesRepositoryPort,
} from '@/core/quotes/ports';

/** SPEC-008 — CDI/IPCA/Selic/IBOV history. Shared reference table; no `withTenant`. */
export class DrizzleIndexSeriesRepository implements IndexSeriesRepositoryPort {
  constructor(private readonly db: Database) {}

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
