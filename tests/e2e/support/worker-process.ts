import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The background worker, running alongside the E2E server.
 *
 * **Why it cannot be a Playwright `webServer` entry.** Those are polled until a
 * URL answers, and the worker deliberately exposes no HTTP surface — it is a
 * pg-boss consumer. It is started here instead, and readiness is established
 * the only way that is meaningful for a queue consumer: by the job it is
 * supposed to process completing (the import spec waits for the batch to leave
 * `pending`), not by a port opening.
 *
 * **Why the suite needs it at all.** SPEC-005 BR-005-13 puts staging and commit
 * behind the `import.stage` and `import.commit` queues, to keep the 60-second
 * parse-and-apply budget off the request path. That is the right design, and it
 * means an import journey with no worker running stops at "pending" forever — a
 * suite written against that would assert the upload form works and call it an
 * import journey.
 */
let worker: ChildProcess | undefined;

/**
 * Recomputed rather than read from `process.env`: `globalSetup` may run in a
 * different process from the config module depending on how Playwright is
 * invoked, and a worker that resolves a *different* upload directory from the
 * web server fails with a missing file — which reads as a parser bug.
 */
const UPLOAD_DIR = path.resolve(process.cwd(), '.data/e2e-imports');

export function startWorker(): void {
  if (worker) return;

  worker = spawn('pnpm', ['worker'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, IMPORT_UPLOAD_DIR: process.env.IMPORT_UPLOAD_DIR ?? UPLOAD_DIR },
    // Detached so the whole process group can be signalled: `pnpm` spawns
    // `tsx`, and killing only the `pnpm` shim leaves the consumer holding its
    // pg-boss connections open, which then blocks the database teardown.
    detached: true,
  });

  worker.on('error', (error) => {
    throw new Error(`E2E worker failed to start: ${error.message}`);
  });
}

export function stopWorker(): void {
  if (!worker?.pid) return;
  try {
    process.kill(-worker.pid, 'SIGTERM');
  } catch {
    // Already gone — the teardown's job is that it is not running, and it
    // is not. Throwing here would fail a green run at the last step.
  }
  worker = undefined;
}
