/**
 * Next.js instrumentation hook — runs once, before the server starts
 * accepting requests. This is the `web` half of AR-41: "both web and worker
 * validate on boot. A bad value must not start half the system." The worker
 * half is `src/worker/index.ts#startWorker`.
 *
 * Only the Node.js runtime touches the database — the edge runtime (middleware,
 * some route handlers) never runs this, and never needs to: it does not read
 * config directly.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { db } = await import('@/db/client');
  const { validateConfigOrExit } = await import('@/config/validate');

  // SPEC-002 BR-002-04: fails the boot loudly on an invalid value, never
  // falls back to a default.
  await validateConfigOrExit(db);
}
