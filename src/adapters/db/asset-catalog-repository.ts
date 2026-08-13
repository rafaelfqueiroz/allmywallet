import { eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { assets } from '@/db/schema/assets';
import { AssetId } from '@/core/shared/ids';
import type { Asset, AssetCatalogPort, AssetClass } from '@/core/quotes/ports';

/**
 * SPEC-008 BR-008-16 — the catalog `getQuote` (`core/quotes/read-through.ts`)
 * validates a ticker against before any provider call. `assets` is a shared
 * reference table (AR-15/BR-003-06), so this queries `db` directly, never
 * `withTenant`.
 *
 * The table is defined by SPEC-006 (`db/schema/assets.ts`), because
 * `transactions.asset_id` needs a foreign key target. SPEC-008 reads and
 * upserts into it rather than owning it.
 */
export class DrizzleAssetCatalogRepository implements AssetCatalogPort {
  constructor(private readonly db: Database) {}

  async findByCode(code: string): Promise<Asset | null> {
    const [row] = await this.db.select().from(assets).where(eq(assets.code, code));
    return row ? toDomain(row) : null;
  }

  async findById(id: AssetId): Promise<Asset | null> {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, id));
    return row ? toDomain(row) : null;
  }

  async findByIds(ids: readonly AssetId[]): Promise<readonly Asset[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(assets)
      .where(inArray(assets.id, [...ids]));
    return rows.map(toDomain);
  }

  /** AR-19: `ON CONFLICT (code)` — a retried sync for a title already onboarded never creates a duplicate row. */
  async upsertByCode(input: {
    code: string;
    name: string;
    assetClass: AssetClass;
  }): Promise<Asset> {
    const [row] = await this.db
      .insert(assets)
      // The id is generated here rather than defaulted in the schema because
      // SPEC-006 owns the table and declares no default; on the conflict path
      // it is discarded and the existing row's id is kept.
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
      .returning();
    if (!row) throw new Error('DrizzleAssetCatalogRepository.upsertByCode: upsert returned no row');
    return toDomain(row);
  }
}

function toDomain(row: typeof assets.$inferSelect): Asset {
  return {
    id: AssetId.of(row.id),
    code: row.code,
    name: row.name,
    // `assets_class_check` restricts the column to exactly the eight members
    // of AssetClass, so this cast narrows `text` to a value the database has
    // already guaranteed. It is the CHECK that makes it true, not this line.
    assetClass: row.assetClass as AssetClass,
  };
}
