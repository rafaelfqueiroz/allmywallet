import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { assets, institutions } from '@/db/schema/assets';
import { AssetId, InstitutionId } from '@/core/shared/ids';
import { canonicalAssetCode } from '@/core/ingestion/asset-identity';
import {
  canonicalInstitutionName,
  institutionIdentityKey,
} from '@/core/ingestion/institution-identity';
import type {
  AssetResolveInput,
  AssetResolverPort,
  InstitutionResolverPort,
} from '@/core/ingestion/ports';

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

  /**
   * AR-19: `ON CONFLICT (code)` — a retried commit for a ticker already onboarded never creates a duplicate.
   *
   * #108: only a *stated* class or name overwrites the catalog's; a guess
   * leaves that column of an existing asset as it is. The conflict always
   * updates `updated_at`, so `RETURNING` yields the id either way.
   *
   * #135: `canonicalAssetCode` (`core/ingestion/asset-identity.ts`) decides
   * what "one instrument" means; this is where that decision reaches the
   * catalogue, exactly as `DrizzleInstitutionResolver` below is for an
   * institution's spellings. The parsers are left alone deliberately — B3's
   * export did not move, so SPEC-020 BR-020-25's guide stamp must not read as
   * though it had — and the extract's own code survives in
   * `import_rows.parsed_payload`, as B3's own institution spelling does.
   *
   * Negociação has no product name, so its ticker doubles as one
   * (`negociacao.ts`); an aliased code must not then name the asset after a
   * settlement ticker. Any name an extract actually states is left as it is.
   */
  async resolve(input: AssetResolveInput): Promise<AssetId> {
    const code = canonicalAssetCode(input.code);
    const [row] = await this.db
      .insert(assets)
      .values({
        id: AssetId.generate(),
        code,
        name: input.name === input.code ? code : input.name,
        assetClass: input.assetClass,
      })
      .onConflictDoUpdate({
        target: assets.code,
        set: {
          ...(input.nameStated ? { name: input.name } : {}),
          ...(input.classStated ? { assetClass: input.assetClass } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: assets.id });
    if (!row) throw new Error('DrizzleAssetResolver.resolve: upsert returned no row');
    return AssetId.of(row.id);
  }
}

/**
 * #136 — one institution, one row, whichever way B3 spelled it.
 *
 * A position is keyed by `(asset, institution)` (SPEC-007 BR-007-08), so a
 * second row for one real broker splits a holding in two and every rule keyed
 * on the position then reads half of it. `institutionIdentityKey`
 * (`core/ingestion/institution-identity.ts`) decides what "one institution"
 * means; this class is where that decision reaches the catalogue.
 *
 * The catalogue is read once per instance and indexed by that key, so a
 * spelling arriving for the first time finds the row an *earlier* spelling
 * created rather than inserting beside it — which is what the name unique
 * constraint alone cannot do. Institutions are a shared reference table
 * (AR-15) of a handful of rows; one `SELECT` per staging or commit
 * transaction is cheaper than the per-row upsert it replaces.
 *
 * The cache is per instance and never outlives its transaction: the resolvers
 * are constructed inside the `withTenant` transaction they serve
 * (`worker/handlers/import.ts`), so it cannot serve a stale catalogue to a
 * later request.
 */
export class DrizzleInstitutionResolver implements InstitutionResolverPort {
  constructor(private readonly db: Tx | Database) {}

  #byIdentity: Map<string, InstitutionId> | null = null;

  async resolve(name: string): Promise<InstitutionId> {
    const known = await this.#catalogue();
    const identity = institutionIdentityKey(name);
    const existing = known.get(identity);
    if (existing !== undefined) return existing;

    // AR-19: a retried commit racing itself on the same spelling still creates
    // one row — the name unique constraint is the floor under the cache.
    const [row] = await this.db
      .insert(institutions)
      .values({ id: InstitutionId.generate(), name: canonicalInstitutionName(name) })
      .onConflictDoUpdate({ target: institutions.name, set: { updatedAt: new Date() } })
      .returning({ id: institutions.id });
    if (!row) throw new Error('DrizzleInstitutionResolver.resolve: upsert returned no row');

    const id = InstitutionId.of(row.id);
    known.set(identity, id);
    return id;
  }

  async #catalogue(): Promise<Map<string, InstitutionId>> {
    if (this.#byIdentity !== null) return this.#byIdentity;
    const rows = await this.db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .orderBy(institutions.name);

    // A ledger still holding both spellings of a split — imported before
    // `0024` merged them — resolves to the canonical row where one exists and
    // otherwise to the first by name, rather than starting a third. Never to
    // whichever row Postgres returned first: two imports must not disagree.
    const byIdentity = new Map<string, InstitutionId>();
    for (const row of rows) {
      const identity = institutionIdentityKey(row.name);
      const isCanonical = row.name === canonicalInstitutionName(row.name);
      if (isCanonical || !byIdentity.has(identity))
        byIdentity.set(identity, InstitutionId.of(row.id));
    }
    this.#byIdentity = byIdentity;
    return byIdentity;
  }
}
