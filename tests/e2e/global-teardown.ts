import { stopWorker } from './support/worker-process';

export default function globalTeardown(): void {
  stopWorker();
}
