import type { Clock } from '@/core/shared/clock';
import type { CorporateEventFactorSource, CorporateEventFactorStore } from './corporate-event-factors';

export interface RefreshCorporateEventFactorsDeps {
  readonly source: CorporateEventFactorSource;
  readonly store: CorporateEventFactorStore;
  readonly clock: Clock;
}

export interface RefreshCorporateEventFactorsSummary {
  /** Issuers actually fetched from `source` this run. */
  readonly fetched: number;
  /** Issuers whose stored fetch was fresh enough to skip. */
  readonly skipped: number;
  /** Of `fetched`, how many came back `failed`. */
  readonly failed: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;

function isFresh(record: { outcome: string; fetchedAt: Date }, now: Date, refreshAgeDays: number): boolean {
  if (record.outcome === 'failed') return false;
  const ageMs = now.getTime() - record.fetchedAt.getTime();
  return ageMs < refreshAgeDays * MILLISECONDS_PER_DAY;
}

/**
 * SPEC-008 BR-008-29 (#113) — refreshes B3's published corporate-event
 * factor for every **distinct** issuer among `issuerCodes` whose last fetch
 * is missing, `failed`, or older than `refreshAgeDays`
 * (`quotes.b3_factor_refresh_days`, SPEC-002 — a registry key, never a
 * constant). A fresh `ok` or `not_listed` record is left alone.
 *
 * A source failure is recorded via `store.recordFetch` and counted in the
 * summary — never thrown. BR-008-29: "a missing or unreachable factor leaves
 * the event unconfirmed rather than guessed", which means an outage here
 * must never fail the caller (the commit use case that calls this before its
 * own transaction, per the issue's plan).
 */
export async function refreshCorporateEventFactors(
  deps: RefreshCorporateEventFactorsDeps,
  issuerCodes: readonly string[],
  refreshAgeDays: number,
): Promise<RefreshCorporateEventFactorsSummary> {
  const distinctIssuers = [...new Set(issuerCodes)];
  if (distinctIssuers.length === 0) return { fetched: 0, skipped: 0, failed: 0 };

  const lastFetches = await deps.store.lastFetches(distinctIssuers);
  const now = deps.clock.now();

  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  for (const issuerCode of distinctIssuers) {
    const last = lastFetches.get(issuerCode);
    if (last !== undefined && isFresh(last, now, refreshAgeDays)) {
      skipped += 1;
      continue;
    }

    const result = await deps.source.fetchIssuer(issuerCode);
    await deps.store.recordFetch(issuerCode, result, now);
    fetched += 1;
    if (result.outcome === 'failed') failed += 1;
  }

  return { fetched, skipped, failed };
}
