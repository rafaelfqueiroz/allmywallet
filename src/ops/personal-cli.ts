import { uuidv7 } from 'uuidv7';
import { db, closePool } from '@/db/client';
import { backupRuns } from '@/db/schema/observability';
import { resolveConfig } from '@/config/resolve';
import { rebuildAll } from '@/ops/rebuild-positions';
import { logger } from '@/lib/logger';

/**
 * SPEC-021 — what the personal instance needs from the application itself,
 * bundled into the image as `dist/ops.js` and run through
 * `docker compose run --rm --no-deps web node dist/ops.js <command>`.
 *
 * The two `scripts/personal/backup.sh` calls live in TypeScript rather than in
 * the script so neither is a second source of truth: the retention count is resolved through the SPEC-002
 * registry (default, deployment override and validation all included), not a
 * `14` repeated in shell, and the outcome row is written through the schema.
 *
 *   backup-retain-count            prints `backup.retain_count` (BR-021-19)
 *   backup-record succeeded <file> records a successful dump (BR-021-20)
 *   backup-record failed <reason>  records a failure, shown until the next success
 *   rebuild-positions              replays every tenant's ledger into the
 *                                  position cache (SPEC-007 BR-007-14, DM-4)
 *
 * `rebuild-positions` is `pnpm positions:rebuild --all` made runnable where it
 * is actually needed. The pnpm script needs the repository, a toolchain and a
 * `DATABASE_URL` typed by hand at the personal instance; this runs inside the
 * image that already holds all three, through the same
 * `docker compose run --rm --no-deps web node dist/ops.js …` the backup uses.
 * #136's merge deletes the cached positions it cannot replay in SQL, so a
 * migration that needs a rebuild afterwards now has one an operator can run.
 */
export async function runPersonalCommand(argv: readonly string[]): Promise<string> {
  const [command, ...args] = argv;

  if (command === 'backup-retain-count') {
    const { value } = await resolveConfig('backup.retain_count', { db });
    return String(value);
  }

  if (command === 'backup-record') {
    const [status, text] = args;
    if (status !== 'succeeded' && status !== 'failed') {
      throw new Error(`backup-record: status must be succeeded or failed, got "${status ?? ''}"`);
    }
    await db.insert(backupRuns).values({
      id: uuidv7(),
      status,
      fileName: status === 'succeeded' ? (text ?? null) : null,
      detail: status === 'failed' ? (text ?? null) : null,
    });
    return `recorded ${status}`;
  }

  if (command === 'rebuild-positions') {
    const outcomes = await rebuildAll({ all: true });
    const drifted = outcomes.filter((outcome) => outcome.drift.length > 0);
    return (
      `rebuilt ${outcomes.length} tenant(s); ` +
      `${drifted.length} had positions that disagreed with the ledger`
    );
  }

  throw new Error(
    `unknown command "${command ?? ''}" — expected backup-retain-count, backup-record or rebuild-positions`,
  );
}

if (process.argv[1]?.includes('ops') || process.argv[1]?.includes('personal-cli')) {
  runPersonalCommand(process.argv.slice(2))
    .then(async (output) => {
      process.stdout.write(`${output}\n`);
      await closePool();
    })
    .catch(async (error: unknown) => {
      logger.error({ err: error }, 'personal ops command failed');
      await closePool();
      process.exit(1);
    });
}
