import { startWorker } from './support/worker-process';

/**
 * Playwright's `globalSetup`. Starts the pg-boss consumer the import journey
 * needs; see `support/worker-process.ts` for why it is not a `webServer`.
 */
export default function globalSetup(): void {
  startWorker();
}
