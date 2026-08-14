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
    const instance = new PgBoss({ connectionString: env().DATABASE_URL, schema: 'pgboss' });
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
