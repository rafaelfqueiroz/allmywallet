import { NextResponse } from 'next/server';
import { getPool } from '@/db/client';
import { db } from '@/db/client';
import { resolveConfig } from '@/config/resolve';
import { aggregateStatus, checkDatabase, checkQuoteSync, checkWorkerLiveness } from '@/lib/health';

/**
 * AR-33/AR-50: a route handler, not a server action — health probes are
 * polled by an external monitor (Uptime Kuma, SPEC-016 BR-016-08's 99%
 * monthly target) with no session and no form to submit.
 *
 * Never cached: an operator or Uptime Kuma polling this must see the current
 * state, not a stale snapshot served by Next.js's route cache.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const pool = getPool();

  // BR-016-14: the staleness threshold is config, not a hardcoded number.
  const staleAfterSeconds = (
    await resolveConfig('observability.worker_heartbeat_stale_seconds', { db })
  ).value;

  const [database, worker, quoteSync] = await Promise.all([
    checkDatabase(pool),
    checkWorkerLiveness(pool, staleAfterSeconds),
    checkQuoteSync(pool),
  ]);

  const status = aggregateStatus([database, worker, quoteSync]);

  return NextResponse.json(
    {
      status,
      checkedAt: new Date().toISOString(),
      components: { database, worker, quoteSync },
    },
    // 'unknown' components (quote sync before SPEC-008/#11 lands) never pull
    // the HTTP status down — only a genuine 'down' does, which is what keeps
    // Uptime Kuma's up/down signal meaningful rather than permanently red
    // before every dependent spec has shipped.
    { status: status === 'down' ? 503 : 200 },
  );
}
