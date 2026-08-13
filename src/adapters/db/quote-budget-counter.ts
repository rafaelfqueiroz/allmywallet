import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { quoteBudgetUsage } from '@/db/schema/market';
import type { BudgetCounterPort, BudgetKind, BudgetUsage } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-19/20 — the monthly, provider-wide request counter. Shared,
 * process-wide, no personal data (see the dispatch report / shared-tables.ts
 * for the BR-003-06 reasoning); no `withTenant`.
 */
export class DrizzleQuoteBudgetCounter implements BudgetCounterPort {
  constructor(private readonly db: Database) {}

  async getUsage(yearMonth: string): Promise<BudgetUsage> {
    const rows = await this.db
      .select({ kind: quoteBudgetUsage.kind, count: quoteBudgetUsage.count })
      .from(quoteBudgetUsage)
      .where(eq(quoteBudgetUsage.yearMonth, yearMonth));

    const scheduled = rows.find((r) => r.kind === 'scheduled')?.count ?? 0;
    const ondemand = rows.find((r) => r.kind === 'ondemand')?.count ?? 0;
    return { scheduled, ondemand };
  }

  /**
   * AR-19: a single atomic `INSERT ... ON CONFLICT DO UPDATE SET count =
   * count + 1` — the increment happens in the database, not "read then
   * write" in application code, so two concurrent successful provider calls
   * (a scheduled poll and an on-demand lookup landing at the same instant)
   * can never lose one to a race.
   */
  async increment(yearMonth: string, kind: BudgetKind): Promise<void> {
    await this.db
      .insert(quoteBudgetUsage)
      .values({ yearMonth, kind, count: 1 })
      .onConflictDoUpdate({
        target: [quoteBudgetUsage.yearMonth, quoteBudgetUsage.kind],
        set: { count: sql`${quoteBudgetUsage.count} + 1`, updatedAt: new Date() },
      });
  }
}
