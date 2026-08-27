import { sql } from 'drizzle-orm';
import { db as globalDb, type Database } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { users } from '@/db/schema/users';
import { positions } from '@/db/schema/positions';
import { AssetId, UserId } from '@/core/shared/ids';
import type { HeldAssetsPort } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-08/BR-008-25 — "the polling set is derived, not
 * configured: exactly the distinct assets in at least one user's non-zero
 * position", across every tenant (quotes are shared, BR-008-25).
 *
 * **Defect found and fixed in passing (issue #90's Decision log — SPEC-018
 * depends on this working).** This class used to be
 * `NoLedgerHeldAssetsRepository`, a placeholder from the branch where
 * SPEC-006/007's `positions` table did not exist yet, hardcoded to return an
 * empty set — "nobody holds anything" was the honest answer at the time. That
 * table landed months ago and nothing ever replaced the body, so in
 * production today `quotes.poll` (`src/worker/handlers/quotes.ts`) computes
 * an empty polling set on every run, no provider is ever called, no row is
 * ever written to `latest_quotes`, and `budget.check`
 * (`src/worker/handlers/budget.ts`) has been evaluating the budget against a
 * permanently-zero held-asset count. SPEC-018 hangs its whole evaluation
 * trigger off a quote write that has never once happened (BR-018-11) — this
 * feature would have shipped inert without this fix.
 *
 * `positions` is tenant-scoped and `FORCE`-RLS'd, so a bare cross-tenant
 * `SELECT DISTINCT asset_id FROM positions WHERE quantity <> 0` returns
 * nothing at all rather than every tenant's rows — exactly the walk
 * `src/worker/handlers/valuation.ts`'s `listTenantIds` already uses:
 * enumerate tenants from `users` (the one deliberately cross-tenant read,
 * ARCHITECTURE §5 — ids only) and union a per-tenant `withTenant` read.
 */
export class DrizzleHeldAssetsRepository implements HeldAssetsPort {
  constructor(private readonly database: Database = globalDb) {}

  async listDistinctHeldAssetIds(): Promise<readonly AssetId[]> {
    const tenants = await this.database.select({ id: users.id }).from(users);

    const held = new Set<string>();
    for (const tenant of tenants) {
      const userId = UserId.of(tenant.id);
      const rows = await withTenant(
        userId,
        (tx) =>
          tx
            .select({ assetId: positions.assetId })
            .from(positions)
            // `positions.quantity >= 0` always holds (its own CHECK), so `> 0`
            // and BR-008-08's "non-zero" agree without needing `<>`.
            .where(sql`${positions.quantity} > 0`),
        this.database,
      );
      for (const row of rows) held.add(row.assetId);
    }

    return [...held].map((id) => AssetId.of(id));
  }
}
