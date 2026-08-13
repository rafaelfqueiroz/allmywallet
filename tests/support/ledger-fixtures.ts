import { Pool } from 'pg';
import { AssetId, InstitutionId } from '@/core/shared/ids';

/**
 * Seeds the shared reference rows (`assets`, `institutions`) the ledger's
 * foreign keys require. Not tenant data (AR-15), so they are inserted directly
 * rather than through `withTenant`.
 *
 * `ON CONFLICT DO NOTHING` on the *code*, with the existing id read back:
 * suites share one database (TS-03), and a fixture that assumed it was the
 * first to insert `PETR4` would either fail on the unique constraint or hand
 * back an id no row actually has.
 */
export interface SeededAsset {
  readonly id: AssetId;
  readonly code: string;
}

export async function seedAsset(
  migrationUrl: string,
  code: string,
  name: string,
  assetClass = 'stock',
): Promise<SeededAsset> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const id = AssetId.generate();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO assets (id, code, name, class)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [id, code, name, assetClass],
    );
    const returned = rows[0]?.id;
    if (returned === undefined) throw new Error(`seedAsset: no id returned for ${code}`);
    return { id: AssetId.of(returned), code };
  } finally {
    await pool.end();
  }
}

export async function seedInstitution(migrationUrl: string, name: string): Promise<InstitutionId> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const id = InstitutionId.generate();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO institutions (id, name)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [id, name],
    );
    const returned = rows[0]?.id;
    if (returned === undefined) throw new Error(`seedInstitution: no id returned for ${name}`);
    return InstitutionId.of(returned);
  } finally {
    await pool.end();
  }
}

/** BR-006-02: a batch to attribute imported rows to. Tenant-scoped, so RLS applies. */
export async function seedImportBatch(
  migrationUrl: string,
  userId: string,
  id: string,
  source = 'b3_negociacao',
): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await pool.query(
      `INSERT INTO import_batches (id, user_id, source, status)
       VALUES ($1, $2, $3, 'committed')
       ON CONFLICT (id) DO NOTHING`,
      [id, userId, source],
    );
  } finally {
    await pool.end();
  }
}
