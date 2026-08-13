/**
 * Next.js instrumentation hook — runs once, before the server starts
 * accepting requests. This is the `web` half of AR-41: "both web and worker
 * validate on boot. A bad value must not start half the system." The worker
 * half is `src/worker/index.ts#startWorker`.
 *
 * Only the Node.js runtime touches the database — the edge runtime (middleware,
 * some route handlers) never runs this for config validation, though it does
 * still load Sentry's edge config below.
 *
 * DEVIATION (SPEC-016 #19, flagged for the Decision log): this file previously
 * lived at `src/app/instrumentation.ts`. Next.js only auto-loads
 * `instrumentation.ts` from the project root or, with a `src/` directory
 * (this project's layout — ARCHITECTURE §3), from `src/instrumentation.ts`
 * directly — never from `src/app/`. That location meant AR-41's web-boot
 * validation was never actually running under `next start`/`next dev`; only
 * the worker half was. Moved here as part of wiring AR-48 (Sentry), since it
 * surfaced while adding the `onRequestError` hook, which has the same
 * discovery requirement.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');

    const { db } = await import('@/db/client');
    const { validateConfigOrExit } = await import('@/config/validate');

    // SPEC-002 BR-002-04: fails the boot loudly on an invalid value, never
    // falls back to a default.
    await validateConfigOrExit(db);
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// AR-48/AR-39: Sentry's own hook for errors thrown inside a Server Component,
// route handler or server action that Next.js catches before user code gets a
// chance to. `captureRequestError` reports through the same client `register()`
// configures above, so it inherits the same `beforeSend` scrubbing — there is
// no separate options object to keep in sync here.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
