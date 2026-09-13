import { uuidv7 } from 'uuidv7';
import { db, closePool } from '@/db/client';
import { backupRuns } from '@/db/schema/observability';
import { resolveConfig } from '@/config/resolve';
import { logger } from '@/lib/logger';

/**
 * SPEC-021 — the two things `scripts/personal/backup.sh` needs from the
 * application, bundled into the image as `dist/ops.js` and run through
 * `docker compose run --rm --no-deps web node dist/ops.js <command>`.
 *
 * They live in TypeScript rather than in the script so neither is a second
 * source of truth: the retention count is resolved through the SPEC-002
 * registry (default, deployment override and validation all included), not a
 * `14` repeated in shell, and the outcome row is written through the schema.
 *
 *   backup-retain-count            prints `backup.retain_count` (BR-021-19)
 *   backup-record succeeded <file> records a successful dump (BR-021-20)
 *   backup-record failed <reason>  records a failure, shown until the next success
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

  throw new Error(`unknown command "${command ?? ''}" — expected backup-retain-count or backup-record`);
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
