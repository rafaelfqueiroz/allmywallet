import { PgBoss } from 'pg-boss';
import { env } from '@/lib/env';
import { db } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import {
  DEAD_LETTER_QUEUE,
  deadLetterCreateOptions,
  queueCreateOptions,
  type QueueName,
} from '@/worker/queues';

/**
 * AR-16 — "the web process may enqueue (`boss.send`) but never schedules or
 * consumes." This is the one place `web` touches `pg-boss` at all: no
 * `.work()`, no `.schedule()`, so cron ownership stays entirely with
 * `src/worker/index.ts`.
 *
 * SPEC-005 is the first feature that needs web → worker enqueue at all
 * (every prior queue is cron-driven) — `import.stage`/`import.commit` fire
 * the moment a user uploads a file or confirms a preview, not on a
 * schedule.
 */
let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const instance = new PgBoss({
      connectionString: env().DATABASE_URL,
      schema: 'pgboss',
      /**
       * Same reason as `src/worker/index.ts`: `0006_pgboss_schema.sql` creates
       * the schema as the migrator and grants `USAGE, CREATE` on it to
       * `allmywallet_app`. pg-boss's own `CREATE SCHEMA IF NOT EXISTS` needs
       * `CREATE` **on the database**, which the runtime role does not have and
       * must not — so leaving this on fails `permission denied for database`
       * on the first enqueue against a database where pg-boss has not been
       * installed yet.
       *
       * The web process hits this before the worker does whenever a user
       * uploads before any cron has fired, which on a fresh deployment is the
       * normal order of events.
       */
      createSchema: false,
    });
    await instance.start();
    boss = instance;
    return instance;
  })();
  return starting;
}

/**
 * Queues this process has already ensured, so the extra round trip is paid
 * once per queue per process rather than on every enqueue.
 */
const ensured = new Set<QueueName>();

/**
 * SPEC-005 BR-005-09 — **the upload must not depend on the worker having
 * booted first.**
 *
 * `createQueue` was the worker's alone, and pg-boss v12 refuses to `send` to
 * a queue that does not exist yet. On CI this surfaced as a 500 on the import
 * journey 412 ms before `worker started` was logged; in production the same
 * window opens on a first deploy against a fresh database, and on any deploy
 * that adds a queue name where web rolls out before worker.
 *
 * The failure was not merely a failed upload. `uploadExtractAction` inserts
 * the `import_batches` row *before* enqueuing, so the user got an error page,
 * a batch stranded at `pending`, and an uploaded `.xlsx` left on disk — the
 * one artefact in the system holding a raw CPF (DL-005-07).
 *
 * **AR-16 still holds**: this creates a queue, it does not `.schedule()` or
 * `.work()` one. Cron ownership and consumption stay entirely with
 * `src/worker/index.ts`. What is shared is the *policy*, through
 * `queueCreateOptions` — because `createQueue` is create-if-not-exists and
 * silently ignores the options of an already-existing queue, so a web process
 * that won the race with different options would set them permanently.
 */
async function ensureQueue(instance: PgBoss, queue: QueueName): Promise<void> {
  if (ensured.has(queue)) return;

  // SPEC-016 BR-016-13/14: the same registry key the worker reads at boot —
  // neither process hardcodes a threshold, so neither can drift from the other.
  const backlogThreshold = (await resolveConfig('alerts.queue_backlog_threshold', { db })).value;

  // AR-20: every queue names DEAD_LETTER_QUEUE as its `deadLetter`, and
  // pg-boss validates that reference when the queue is created — so on a
  // database where nothing exists yet, creating `import.stage` fails with
  // `Queue dead-letter does not exist`. The worker creates this one first for
  // the same reason. Creating it here is still not consuming it: the
  // dead-letter *handler*, which is what turns a dead job into an alert,
  // remains the worker's alone.
  await instance.createQueue(DEAD_LETTER_QUEUE, deadLetterCreateOptions(backlogThreshold));

  await instance.createQueue(queue, queueCreateOptions(queue, backlogThreshold));
  ensured.add(queue);
}

/** AR-21: payloads carry ids, not objects — every call site here passes exactly that. */
export async function enqueue<T extends object>(queue: QueueName, payload: T): Promise<void> {
  const instance = await getBoss();
  await ensureQueue(instance, queue);
  await instance.send(queue, payload);
}
