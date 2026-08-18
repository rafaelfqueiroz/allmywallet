import { eq, sql } from 'drizzle-orm';
import { db, closePool } from '@/db/client';
import { assets, transactions, users } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { AssetId, UserId } from '@/core/shared/ids';
import { hashUserId, logger } from '@/lib/logger';
import {
  REFERENCE_ASSET_CLASS_TO_SCHEMA,
  REFERENCE_TRANSACTION_COUNT,
  REFERENCE_USER_ID,
  generateReferenceWorkload,
  referenceTransactionRows,
  type ReferenceAsset,
  type ReferenceWorkload,
} from '@/db/reference-workload';

/**
 * `pnpm db:seed:reference` (package.json) — SPEC-016 TS-23's reference
 * workload: 100 assets, 10.000 transactions, 5 years of history, seeded for
 * the fixed reference tenant so `nightly.yml` measures every budget against a
 * named scale (BR-016-01) rather than against whatever happens to be in the
 * database.
 *
 * DEVIATION (SPEC-016 #19, for the Decision log): the issue's Modules table
 * names `src/db/seed/reference-workload.ts`. `package.json`'s
 * `db:seed:reference` script (already committed, ahead of this task) instead
 * wires `tsx src/db/seed-reference.ts` — followed here rather than changed,
 * per "build on existing wiring, do not duplicate it." The pure generator
 * lives at `src/db/reference-workload.ts`; this file is the thin persistence
 * entrypoint the script actually runs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROWS ARE INSERTED RATHER THAN CREATED
 *
 * `createTransaction` is the right way to add *a* transaction and the wrong
 * way to add ten thousand: it replays the whole position on every call to
 * satisfy BR-006-15, so seeding this workload through it is quadratic and
 * would take the nightly run out of "nightly" territory entirely.
 *
 * What it buys — the sell-more-than-held guard — the generator already
 * provides structurally: `generateReferenceTransactions` sorts by date and
 * makes the first row for every ticker a buy, for exactly this reason. The
 * rows are still built through `naturalKeyFor` and `computeTotalValue` rather
 * than by hand, so a fixture can never disagree with the ledger about what a
 * natural key or a total is.
 *
 * `positions` is deliberately **not** seeded here. SPEC-007 owns that table
 * and its rebuild entry point (#10); a seeder writing position rows itself
 * would be asserting an average cost the engine never computed, which is the
 * one thing DM-4 exists to prevent.
 * ---------------------------------------------------------------------------
 */

/** Chunked so one statement never carries ten thousand rows of parameters. */
const INSERT_CHUNK = 500;

export async function seedReferenceWorkload(): Promise<ReferenceWorkload> {
  const workload = generateReferenceWorkload();
  const userId = UserId.of(REFERENCE_USER_ID);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (existing.length === 0) {
    await db.insert(users).values({
      id: userId,
      googleSubjectId: 'reference-workload-fixed-subject',
      email: 'reference-workload@example.invalid',
      name: 'SPEC-016 reference workload',
    });
  }

  // AR-15: `assets` is shared reference data with no tenant column, so it is
  // written on the pooled `db`, outside `withTenant` — and by code, because a
  // re-run must land on the same rows rather than duplicating the catalogue.
  const assetIds = await upsertAssets(workload.assets);

  const seeded = await withTenant(
    userId,
    async (tx) => {
      // Idempotent, and cheap to check: the nightly job seeds before every
      // measurement, and re-inserting would both fail on the natural-key
      // constraint and change the scale the budgets are stated against.
      const [row] = await tx.select({ total: sql<number>`count(*)::int` }).from(transactions);
      if ((row?.total ?? 0) >= REFERENCE_TRANSACTION_COUNT) return 0;

      const rows = referenceTransactionRows(workload.transactions, assetIds, userId);
      for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
        await tx.insert(transactions).values(rows.slice(start, start + INSERT_CHUNK));
      }
      return rows.length;
    },
    db,
  );

  logger.info(
    {
      assets: workload.assets.length,
      transactions: workload.transactions.length,
      inserted: seeded,
      userId: hashUserId(userId),
    },
    seeded === 0
      ? 'reference workload already seeded; nothing inserted'
      : 'reference workload seeded',
  );

  return workload;
}

/**
 * AR-19: `ON CONFLICT (code)` — the same shape `DrizzleAssetResolver` uses, so
 * a reference ticker that somehow already exists is reused rather than
 * duplicated, and the returned id is always the row's real id.
 */
async function upsertAssets(
  referenceAssets: readonly ReferenceAsset[],
): Promise<ReadonlyMap<string, AssetId>> {
  const ids = new Map<string, AssetId>();
  for (const asset of referenceAssets) {
    const [row] = await db
      .insert(assets)
      .values({
        id: AssetId.generate(),
        code: asset.ticker,
        name: `Reference ${asset.ticker}`,
        assetClass: REFERENCE_ASSET_CLASS_TO_SCHEMA[asset.assetClass],
      })
      .onConflictDoUpdate({ target: assets.code, set: { updatedAt: new Date() } })
      .returning({ id: assets.id });
    if (!row) throw new Error(`seedReferenceWorkload: no id returned for ${asset.ticker}`);
    ids.set(asset.ticker, AssetId.of(row.id));
  }
  return ids;
}

// Only run when invoked directly (`pnpm db:seed:reference`), so tests can
// import `seedReferenceWorkload` without a side-effecting script run.
if (process.argv[1]?.includes('seed-reference')) {
  seedReferenceWorkload()
    .then(async () => {
      await closePool();
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'reference workload seed failed');
      process.exit(1);
    });
}
