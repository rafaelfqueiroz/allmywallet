import { PgBoss } from 'pg-boss';
import { env } from '@/lib/env';
import type { QueueName } from '@/worker/queues';

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

/** AR-21: payloads carry ids, not objects — every call site here passes exactly that. */
export async function enqueue<T extends object>(queue: QueueName, payload: T): Promise<void> {
  const instance = await getBoss();
  await instance.send(queue, payload);
}
