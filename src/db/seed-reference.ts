import { eq } from 'drizzle-orm';
import { db, closePool } from '@/db/client';
import { users } from '@/db/schema';
import { UserId } from '@/core/shared/ids';
import { hashUserId, logger } from '@/lib/logger';
import {
  REFERENCE_USER_ID,
  generateReferenceWorkload,
  type ReferenceWorkload,
} from '@/db/reference-workload';

/**
 * `pnpm db:seed:reference` (package.json) — SPEC-016 TS-23's reference
 * workload, seeded into whatever of it already has a table to seed into.
 *
 * DEVIATION (SPEC-016 #19, for the Decision log): the issue's Modules table
 * names `src/db/seed/reference-workload.ts`. `package.json`'s
 * `db:seed:reference` script (already committed, ahead of this task) instead
 * wires `tsx src/db/seed-reference.ts` — followed here rather than changed,
 * per "build on existing wiring, do not duplicate it." The pure generator
 * lives at `src/db/reference-workload.ts` (no `seed/` subdirectory — nothing
 * else lives there yet, so the extra directory level bought nothing); this
 * file is the thin persistence entrypoint the script actually runs.
 *
 * COUPLING (#9/#10): only the reference user is persisted today. Asset and
 * transaction persistence is the marked extension point below — see
 * `src/db/reference-workload.ts`'s module doc for the full reasoning.
 */
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

  // EXTENSION POINT (#9 SPEC-006 `transactions`, #10 SPEC-007 `positions`):
  // once those migrations exist, insert `workload.assets` into `assets`
  // (already declared in AR-15/SHARED_TABLES, awaiting its own migration) and
  // `workload.transactions` into `transactions` scoped to `userId` via
  // `withTenant` — never a raw `db.insert` for a tenant table (AR-11). Left
  // as a no-op rather than guessed at, so it does not have to be unwound
  // when #9/#10 land with a shape this task cannot see yet.
  logger.info(
    {
      assets: workload.assets.length,
      transactions: workload.transactions.length,
      userId: hashUserId(userId),
    },
    'reference workload generated; assets/transactions not yet persisted — awaiting #9/#10',
  );

  return workload;
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
