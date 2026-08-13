import type { Pool } from 'pg';

/**
 * AR-50/AR-33: `/api/health` reports database reachability, worker liveness
 * and last successful quote sync — three genuinely independent checks, so one
 * failing must degrade its own component rather than fail the whole endpoint
 * (a 500 here is exactly the "silently serving stale as current" BR-016-11
 * warns against, just at the monitoring layer instead of the UI). Uptime
 * Kuma polls this for the SPEC-016 BR-016-08 99% monthly target.
 *
 * DB-touching checks run against a bare `pg.Pool` rather than through
 * Drizzle/`withTenant` — none of the three checks below read tenant data
 * (AR-11 does not apply), and a raw connectivity probe has no query to build.
 */

export type ComponentStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ComponentHealth {
  readonly status: ComponentStatus;
  readonly detail?: string;
}

/**
 * A component probe must never hang the endpoint waiting on a database that
 * is not answering — that would make the health check itself the outage. Not
 * a SPEC-002 registry key: this is an internal safety valve on the probe
 * itself, not a business cadence, threshold or budget (BR-002-01's scope).
 */
const PROBE_TIMEOUT_MS = 3000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkDatabase(pool: Pool): Promise<ComponentHealth> {
  try {
    await withTimeout(pool.query('SELECT 1'), PROBE_TIMEOUT_MS);
    return { status: 'ok' };
  } catch (error) {
    return { status: 'down', detail: error instanceof Error ? error.message : 'unreachable' };
  }
}

/**
 * AR-50's "worker liveness". pg-boss has no built-in "the process is alive"
 * signal (only active job leases, silent when the queue is idle), so the
 * worker writes to `worker_heartbeats` on a config-driven interval
 * (`observability.worker_heartbeat_interval_seconds`) and this reads it back.
 */
export async function checkWorkerLiveness(
  pool: Pool,
  staleAfterSeconds: number,
): Promise<ComponentHealth> {
  try {
    const { rows } = await withTimeout(
      pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM worker_heartbeats WHERE id = 'worker'`,
      ),
      PROBE_TIMEOUT_MS,
    );
    const row = rows[0];
    if (!row) return { status: 'unknown', detail: 'no heartbeat recorded yet' };

    const ageSeconds = (Date.now() - row.updated_at.getTime()) / 1000;
    if (ageSeconds > staleAfterSeconds) {
      return { status: 'down', detail: `heartbeat is ${Math.round(ageSeconds)}s old` };
    }
    return { status: 'ok' };
  } catch (error) {
    // Table not present yet is impossible once this task's migration has run
    // (unlike quote sync, which genuinely belongs to a parallel spec) — a
    // query failure here is a real fault, reported as 'down' rather than
    // masked as 'unknown'.
    return { status: 'down', detail: error instanceof Error ? error.message : 'query failed' };
  }
}

export interface QuoteSyncHealth extends ComponentHealth {
  readonly lastSuccessfulSyncAt: string | null;
}

/**
 * SPEC-008 (#11) is being built in parallel and owns the quote-sync tables —
 * `latest_quotes` is declared in AR-15/`SHARED_TABLES` today but does not
 * exist in the schema yet. This degrades to 'unknown' rather than failing the
 * request when the table (or the expected column on it) is absent, so this
 * endpoint does not have to be revisited the moment #11 lands; it only grows
 * teeth. See the SPEC-016 #19 report's "couplings" section for the exact
 * contract this assumes (`latest_quotes.updated_at`) — #11 should either
 * match it or this function should be revisited alongside that migration.
 */
export async function checkQuoteSync(pool: Pool): Promise<QuoteSyncHealth> {
  try {
    const { rows: tableRows } = await withTimeout(
      pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'latest_quotes'
         ) AS exists`,
      ),
      PROBE_TIMEOUT_MS,
    );
    if (!tableRows[0]?.exists) {
      // SPEC-008 (#11) ships this table, so in a fully migrated database this
      // branch does not fire. It stays because a health probe that throws when
      // the schema is behind is a health probe that cannot report the one
      // condition it most needs to: an app process running against a database
      // the migration step has not reached.
      return {
        status: 'unknown',
        detail: 'latest_quotes does not exist — database schema is behind the running code',
        lastSuccessfulSyncAt: null,
      };
    }

    const { rows: columnRows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'latest_quotes' AND column_name = 'updated_at'
       ) AS exists`,
    );
    if (!columnRows[0]?.exists) {
      return {
        status: 'unknown',
        detail: 'latest_quotes exists but has no updated_at column yet',
        lastSuccessfulSyncAt: null,
      };
    }

    const { rows } = await pool.query<{ last_sync: Date | null }>(
      `SELECT MAX(updated_at) AS last_sync FROM latest_quotes`,
    );
    const lastSync = rows[0]?.last_sync ?? null;
    return {
      status: lastSync ? 'ok' : 'unknown',
      ...(lastSync ? {} : { detail: 'latest_quotes has no rows yet' }),
      lastSuccessfulSyncAt: lastSync ? lastSync.toISOString() : null,
    };
  } catch (error) {
    return {
      status: 'unknown',
      detail: error instanceof Error ? error.message : 'quote-sync check failed',
      lastSuccessfulSyncAt: null,
    };
  }
}

/**
 * Pure aggregation, split out so it is unit-testable without a database.
 * 'down' wins over everything (the database itself, or the worker, being
 * unreachable is a real outage); 'unknown' components (quote sync before
 * #11 lands) never drag the overall status down, since "not built yet" is
 * not "broken" — only 'down' components should.
 */
export function aggregateStatus(
  components: readonly ComponentHealth[],
): 'ok' | 'degraded' | 'down' {
  if (components.some((c) => c.status === 'down')) return 'down';
  if (components.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}
