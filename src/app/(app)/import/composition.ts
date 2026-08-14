import { SystemClock } from '@/core/shared/clock';
import type { UserId } from '@/core/shared/ids';
import type { IngestionDependencies } from '@/core/ingestion/dependencies';
import { buildIngestionDeps } from '@/worker/handlers/import';
import { db } from '@/db/client';
import { withTenant } from '@/db/tenant';

/**
 * The composition root (AR-02) for `/import` — reuses
 * `src/worker/handlers/import.ts`'s `buildIngestionDeps` rather than
 * re-wiring the same seven ports a second time, so the request path and the
 * worker path can never quietly disagree about which adapter backs a port.
 */
const clock = new SystemClock();

export async function withIngestionDeps<T>(
  userId: UserId,
  fn: (deps: IngestionDependencies) => Promise<T>,
): Promise<T> {
  return withTenant(userId, (tx) => fn(buildIngestionDeps(tx, userId, clock)), db);
}
