import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/tenant';
import { opportunityRules } from '@/db/schema/opportunity';
import { AssetId, OpportunityRuleId, type UserId } from '@/core/shared/ids';
import type {
  OpportunityBound,
  OpportunityRule,
  OpportunityRuleRepository,
  OpportunityState,
} from '@/core/opportunity/ports';

/**
 * SPEC-018's rule persistence, in the shape of `DrizzleWalletGoalRepository`
 * (`src/adapters/db/wallet-goal-repository.ts`): AR-11 — every method runs on
 * a `Tx` obtained from `withTenant`; RLS supplies the tenant filter on reads
 * and `WITH CHECK` verifies it on writes, so `user_id` is written explicitly
 * on every insert but never re-added to a WHERE clause.
 */
export class DrizzleOpportunityRuleRepository implements OpportunityRuleRepository {
  constructor(
    private readonly tx: Tx,
    private readonly userId: UserId,
  ) {}

  async findByAsset(assetId: AssetId): Promise<OpportunityRule | null> {
    const [row] = await this.tx
      .select()
      .from(opportunityRules)
      .where(eq(opportunityRules.assetId, assetId));
    return row ? toDomain(row) : null;
  }

  async listAll(): Promise<readonly OpportunityRule[]> {
    const rows = await this.tx.select().from(opportunityRules);
    return rows.map(toDomain);
  }

  async listActiveForAssets(assetIds: readonly AssetId[]): Promise<readonly OpportunityRule[]> {
    if (assetIds.length === 0) return [];
    const rows = await this.tx
      .select()
      .from(opportunityRules)
      .where(
        and(eq(opportunityRules.active, true), inArray(opportunityRules.assetId, [...assetIds])),
      );
    return rows.map(toDomain);
  }

  /**
   * A plain insert, deliberately with no try/catch around
   * `opportunity_rules_user_id_asset_id_key`. The rule-creation use case
   * (`core/opportunity/rule.ts`) already checks `findByAsset` first and
   * returns `RULE_ALREADY_EXISTS` for the ordinary case; the constraint here
   * is the backstop for the race two concurrent creation attempts can still
   * open between that check and this write. Catching the resulting Postgres
   * 23505 here and swallowing it would hide that race behind a silent no-op
   * instead of the loud failure a caller can actually see and retry against.
   */
  async insert(rule: OpportunityRule): Promise<void> {
    await this.tx.insert(opportunityRules).values(toRow(rule, this.userId));
  }

  async update(rule: OpportunityRule): Promise<void> {
    const row = toRow(rule, this.userId);
    await this.tx
      .update(opportunityRules)
      .set({
        lowerBound: row.lowerBound,
        lowerState: row.lowerState,
        upperBound: row.upperBound,
        upperState: row.upperState,
        defaultState: row.defaultState,
        muted: row.muted,
        updatedAt: new Date(),
      })
      .where(eq(opportunityRules.id, rule.id));
  }

  async delete(id: OpportunityRuleId): Promise<void> {
    await this.tx.delete(opportunityRules).where(eq(opportunityRules.id, id));
  }

  /** BR-018-13 — `last_state` and `last_evaluated_at` are written together, always, never one without the other. */
  async recordObservation(id: OpportunityRuleId, state: OpportunityState, at: Date): Promise<void> {
    await this.tx
      .update(opportunityRules)
      .set({ lastState: state, lastEvaluatedAt: at, updatedAt: new Date() })
      .where(eq(opportunityRules.id, id));
  }

  async setActive(ids: readonly OpportunityRuleId[], active: boolean): Promise<void> {
    if (ids.length === 0) return;
    await this.tx
      .update(opportunityRules)
      .set({ active, updatedAt: new Date() })
      .where(inArray(opportunityRules.id, [...ids]));
  }
}

// AR-06/AR-07: `lowerBound`/`upperBound` are already `Money | null` — the
// `money` custom type (src/db/numeric.ts) parses NUMERIC -> Money at the
// driver boundary, never re-parsed through `Number()`.
function toDomain(row: typeof opportunityRules.$inferSelect): OpportunityRule {
  const lower: OpportunityBound | null =
    row.lowerBound !== null && row.lowerState !== null
      ? { price: row.lowerBound, state: row.lowerState as OpportunityState }
      : null;
  const upper: OpportunityBound | null =
    row.upperBound !== null && row.upperState !== null
      ? { price: row.upperBound, state: row.upperState as OpportunityState }
      : null;

  return {
    id: OpportunityRuleId.of(row.id),
    userId: row.userId as UserId,
    assetId: AssetId.of(row.assetId),
    lower,
    upper,
    defaultState: row.defaultState as OpportunityState,
    lastState: row.lastState as OpportunityState | null,
    lastEvaluatedAt: row.lastEvaluatedAt,
    active: row.active,
    muted: row.muted,
  };
}

function toRow(rule: OpportunityRule, userId: UserId): typeof opportunityRules.$inferInsert {
  return {
    id: rule.id,
    userId,
    assetId: rule.assetId,
    lowerBound: rule.lower?.price ?? null,
    lowerState: rule.lower?.state ?? null,
    upperBound: rule.upper?.price ?? null,
    upperState: rule.upper?.state ?? null,
    defaultState: rule.defaultState,
    lastState: rule.lastState,
    lastEvaluatedAt: rule.lastEvaluatedAt,
    active: rule.active,
    muted: rule.muted,
  };
}
