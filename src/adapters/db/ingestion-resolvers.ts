import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { assets, institutions } from '@/db/schema/assets';
import { AssetId, InstitutionId } from '@/core/shared/ids';
import type { AssetClass } from '@/core/quotes/ports';
import type { AssetResolverPort, InstitutionResolverPort } from '@/core/ingestion/ports';

/**
 * SPEC-005 — resolves the free-text product/institution names a B3 extract
 * carries into the catalog's ids, creating either if new. `assets` and
 * `institutions` are shared reference tables (AR-15) needing no tenant
 * context of their own, but `commit-batch.ts`'s composition root
 * (`src/worker/handlers/import.ts`) constructs these from the *same*
 * `withTenant` transaction the rest of a commit runs in — an ordinary
 * Postgres transaction may touch any table, tenant-scoped or not — so both
 * accept either a `Tx` or a bare `Database`.
 */
export class DrizzleAssetResolver implements AssetResolverPort {
  constructor(private readonly db: Tx | Database) {}

  /** AR-19: `ON CONFLICT (code)` — a retried commit for a ticker already onboarded never creates a duplicate. */
  async resolve(input: { code: string; name: string; assetClass: AssetClass }): Promise<AssetId> {
    const [row] = await this.db
      .insert(assets)
      .values({
        id: AssetId.generate(),
        code: input.code,
        name: input.name,
        assetClass: input.assetClass,
      })
      .onConflictDoUpdate({
        target: assets.code,
        set: { name: input.name, assetClass: input.assetClass, updatedAt: new Date() },
      })
      .returning({ id: assets.id });
    if (!row) throw new Error('DrizzleAssetResolver.resolve: upsert returned no row');
    return AssetId.of(row.id);
  }
}

export class DrizzleInstitutionResolver implements InstitutionResolverPort {
  constructor(private readonly db: Tx | Database) {}

  async resolve(name: string): Promise<InstitutionId> {
    const [row] = await this.db
      .insert(institutions)
      .values({ id: InstitutionId.generate(), name })
      .onConflictDoUpdate({ target: institutions.name, set: { updatedAt: new Date() } })
      .returning({ id: institutions.id });
    if (!row) throw new Error('DrizzleInstitutionResolver.resolve: upsert returned no row');
    return InstitutionId.of(row.id);
  }
}
