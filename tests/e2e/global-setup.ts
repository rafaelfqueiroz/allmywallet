import { startWorker } from './support/worker-process';

/**
 * Playwright's `globalSetup`. Starts the pg-boss consumer the import journey
 * needs; see `support/worker-process.ts` for why it is not a `webServer`.
 *
 * **Only when the E2E projects are in the run.** The visual projects
 * photograph rendered pages and never enqueue a job, and they run *inside* the
 * pinned Playwright container (DS-42), which carries Node but no pnpm — so
 * spawning the worker there failed with `spawn pnpm ENOENT` and took the whole
 * run down before a single screenshot. That made recording a baseline locally
 * impossible, and local recording is the only sanctioned way to record one.
 * CI hid it: its visual job installs pnpm into the same container.
 *
 * The selection is read from the command line rather than from `config`:
 * `FullConfig.projects` holds every *configured* project, filtered or not, so
 * it cannot answer "what is actually running". A run that names no project at
 * all runs everything, which includes the E2E suite — hence the empty case
 * starts the worker.
 */
function selectedProjects(): string[] {
  const args = process.argv;
  const names: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      const value = args[index + 1];
      if (value) names.push(value);
    } else if (arg?.startsWith('--project=')) {
      names.push(arg.slice('--project='.length));
    }
  }

  return names;
}

export default function globalSetup(): void {
  const selected = selectedProjects();
  const runsE2E = selected.length === 0 || selected.some((name) => name.startsWith('e2e'));

  if (!runsE2E) return;

  startWorker();
}
