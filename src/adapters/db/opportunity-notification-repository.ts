import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/tenant';
import { opportunityNotifications } from '@/db/schema/opportunity';
import { OpportunityRuleId, type OpportunityNotificationId, type UserId } from '@/core/shared/ids';
import type { OpportunityNotificationLog, OpportunityState } from '@/core/opportunity/ports';

/**
 * SPEC-018 BR-018-24/DL-018-08 — the idempotency log. AR-11: constructed from
 * a `Tx` already inside `withTenant`; `userId` is written explicitly on the
 * insert below and never re-derived from the caller's `entry.userId`, the
 * same discipline every other tenant-scoped repository in this directory
 * follows.
 */
export class DrizzleOpportunityNotificationLog implements OpportunityNotificationLog {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  /**
   * `INSERT … ON CONFLICT (rule_id, state, quote_observed_at) DO NOTHING …
   * RETURNING id` — one statement, not a `SELECT` followed by an `INSERT`.
   * DL-018-08's whole point is that two overlapping attempts (a pg-boss retry
   * racing the original, or two workers) must not both decide "nobody has
   * claimed this yet" and both send — a read-then-write here would
   * reintroduce exactly that race. `rows.length > 0` is `true` only for the
   * caller whose insert actually landed.
   */
  async claim(entry: {
    readonly id: OpportunityNotificationId;
    readonly userId: UserId;
    readonly ruleId: OpportunityRuleId;
    readonly state: OpportunityState;
    readonly quoteObservedAt: Date;
    readonly sentAt: Date;
  }): Promise<boolean> {
    const written = await this.tx
      .insert(opportunityNotifications)
      .values({
        id: entry.id,
        userId: this.userId,
        ruleId: entry.ruleId,
        state: entry.state,
        quoteObservedAt: entry.quoteObservedAt,
        sentAt: entry.sentAt,
      })
      .onConflictDoNothing({
        target: [
          opportunityNotifications.ruleId,
          opportunityNotifications.state,
          opportunityNotifications.quoteObservedAt,
        ],
      })
      .returning({ id: opportunityNotifications.id });
    return written.length > 0;
  }

  async lastSentAt(ruleId: OpportunityRuleId): Promise<Date | null> {
    const [row] = await this.tx
      .select({ sentAt: opportunityNotifications.sentAt })
      .from(opportunityNotifications)
      .where(eq(opportunityNotifications.ruleId, ruleId))
      .orderBy(desc(opportunityNotifications.sentAt))
      .limit(1);
    return row?.sentAt ?? null;
  }

  /**
   * `GROUP BY` rather than N calls to `lastSentAt` — one query for the whole
   * evaluation pass.
   *
   * `max(...)` is a raw SQL expression (`sql\`...\``), not a plain column
   * read — Drizzle's `timestamp` column mapping (which is what turns a
   * driver row's `sent_at` into a JS `Date` for `lastSentAt` above) does not
   * apply to a computed aggregate the same way, and node-postgres hands this
   * one back as a string. Parsed explicitly here rather than trusting the
   * `sql<Date>` type parameter, which is a compile-time annotation only and
   * asserts nothing about what actually comes back at runtime.
   */
  async lastSentAtByRule(
    ruleIds: readonly OpportunityRuleId[],
  ): Promise<ReadonlyMap<OpportunityRuleId, Date>> {
    if (ruleIds.length === 0) return new Map();
    const rows = await this.tx
      .select({
        ruleId: opportunityNotifications.ruleId,
        sentAt: sql<string>`max(${opportunityNotifications.sentAt})`,
      })
      .from(opportunityNotifications)
      .where(inArray(opportunityNotifications.ruleId, [...ruleIds]))
      .groupBy(opportunityNotifications.ruleId);

    const result = new Map<OpportunityRuleId, Date>();
    for (const row of rows) {
      result.set(OpportunityRuleId.of(row.ruleId), new Date(row.sentAt));
    }
    return result;
  }
}
