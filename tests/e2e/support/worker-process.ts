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

/**
 * #123 / #171 — the worker never reaches BCB, Tesouro Transparente or B3's
 * COTAHIST archive from here. Worker-start catch-up runs these syncs before
 * the worker consumes anything, and a first BCB load on a fresh database is
 * 26 years of daily series: a slow or failing public API then ate into the
 * import journey's wait for its batch, which is the failure the journey is
 * least able to tell apart from a broken queue. No journey reads any of
 * these series; the ones that show a price insert it (`holdings.ts`).
 *
 * Port 9 on loopback has nothing listening, so the connection is refused at
 * once: every sync fails in milliseconds, logs it, and the worker starts.
 */
const OFFLINE_MARKET_DATA = {
  BCB_SGS_BASE_URL: 'http://127.0.0.1:9/bcdata.sgs',
  TESOURO_PRICES_URL: 'http://127.0.0.1:9/PrecoTaxaTesouroDireto.csv',
  B3_COTAHIST_BASE_URL: 'http://127.0.0.1:9/cotahist',
};

export function startWorker(): void {
  if (worker) return;

  worker = spawn('pnpm', ['worker'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      IMPORT_UPLOAD_DIR: process.env.IMPORT_UPLOAD_DIR ?? UPLOAD_DIR,
      ...OFFLINE_MARKET_DATA,
    },
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
