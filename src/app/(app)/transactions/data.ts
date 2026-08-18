import { asc, eq } from 'drizzle-orm';
import { AssetId, InstitutionId } from '@/core/shared/ids';
import { db } from '@/db/client';
import { assets, institutions } from '@/db/schema/assets';
import { transactions } from '@/db/schema/transactions';
import type { Tx } from '@/db/tenant';

/**
 * Re-exported so `_components/Controls.tsx` (a `.tsx` file, and therefore
 * subject to AR-31's ESLint ban on `@/db/*` imports) can list the eight asset
 * classes without importing the schema module directly.
 */
export { ASSET_CLASSES } from '@/db/schema/assets';

/**
 * AR-31: Server Components call a use case in `core/` directly, never the
 * database — enforced for `.tsx` files by ESLint. These two read models exist
 * purely to populate the filter selects (BR-006-08) and carry no business
 * rule, so they live here as plain queries rather than as `core/` use cases —
 * the same reasoning `(app)/reports/data.ts` gives for `listInstitutions` and
 * `(app)/wallets/data.ts` for `resolveAssetLabels`.
 */

export interface AssetOption {
  readonly assetId: AssetId;
  readonly code: string;
  readonly name: string;
}

export interface InstitutionOption {
  readonly institutionId: InstitutionId;
  readonly name: string;
}

/**
 * BR-006-08's "asset" filter, scoped to assets this tenant has actually
 * transacted — not the full B3 catalogue, which runs to thousands of rows a
 * `<select>` cannot usefully present. `selectDistinct` plus the join is a
 * tenant-scoped read (`transactions` is RLS-protected), so this runs inside
 * the page's own `withTenant` transaction (AR-11) rather than on the pooled
 * `db`.
 */
export async function listAssetOptions(tx: Tx): Promise<readonly AssetOption[]> {
  const rows = await tx
    .selectDistinct({ id: assets.id, code: assets.code, name: assets.name })
    .from(transactions)
    .innerJoin(assets, eq(assets.id, transactions.assetId))
    .orderBy(asc(assets.code));
  return rows.map((row) => ({ assetId: AssetId.of(row.id), code: row.code, name: row.name }));
}

/**
 * AR-15: `institutions` is shared reference data with no tenant column — the
 * full list, same as `(app)/reports/data.ts#listInstitutions`. Unlike assets
 * the set is small (the handful of Brazilian brokers/banks a user might
 * name), so there is no cardinality reason to scope it to what this tenant
 * has used.
 */
export async function listInstitutionOptions(): Promise<readonly InstitutionOption[]> {
  const rows = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .orderBy(asc(institutions.name));
  return rows.map((row) => ({ institutionId: InstitutionId.of(row.id), name: row.name }));
}
