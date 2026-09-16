import { inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '@/db/client';
import type { Tx } from '@/db/tenant';
import { corporateEventFactorFetches, corporateEventFactors } from '@/db/schema/corporate-event-factors';
import { BusinessDate } from '@/core/shared/clock';
import {
  factorMultiplier,
  type CorporateEventFactor,
  type CorporateEventFactorFetch,
  type CorporateEventFactorFetchOutcome,
  type CorporateEventFactorFetchRecord,
  type CorporateEventFactorKind,
  type CorporateEventFactorStore,
} from '@/core/quotes/corporate-event-factors';

/** Persisted as `corporate_event_factors.source` — the only source this adapter writes. */
const SOURCE = 'b3_listed_companies';

/**
 * SPEC-008 BR-008-29 (#113) — the two shared tables backing
 * `CorporateEventFactorStore`. AR-15: `corporate_event_factors` and
 * `corporate_event_factor_fetches` are declared in `src/db/shared-tables.ts`,
 * carry no `user_id` and no RLS policy — public market data keyed by issuer,
 * not by tenant — so this class queries `db` directly, exactly like
 * `DrizzleQuoteRepository`. AR-02/AR-03: implements the store port declared
 * in `core/quotes/corporate-event-factors.ts`.
 */
export class DrizzleCorporateEventFactorRepository implements CorporateEventFactorStore {
  /**
   * `Database | Tx`, matching `DrizzleQuoteRepository` and
   * `DrizzleAssetCatalogRepository`: the refresh use case runs before an
   * import commit's own transaction (per the issue's plan) but may also run
   * standalone from a worker tick, so both a pooled handle and an existing
   * transaction are legitimate callers.
   */
  constructor(private readonly db: Database | Tx) {}

  async listByIssuers(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly CorporateEventFactor[]>> {
    const result = new Map<string, CorporateEventFactor[]>();
    if (issuerCodes.length === 0) return result;

    const rows = await this.db
      .select()
      .from(corporateEventFactors)
      .where(inArray(corporateEventFactors.issuerCode, [...issuerCodes]));

    for (const row of rows) {
      const factor = toDomainFactor(row);
      const bucket = result.get(factor.issuerCode);
      if (bucket) bucket.push(factor);
      else result.set(factor.issuerCode, [factor]);
    }
    return result;
  }

  async lastFetches(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, CorporateEventFactorFetchRecord>> {
    const result = new Map<string, CorporateEventFactorFetchRecord>();
    if (issuerCodes.length === 0) return result;

    const rows = await this.db
      .select()
      .from(corporateEventFactorFetches)
      .where(inArray(corporateEventFactorFetches.issuerCode, [...issuerCodes]));

    for (const row of rows) {
      result.set(row.issuerCode, {
        issuerCode: row.issuerCode,
        fetchedAt: row.fetchedAt,
        outcome: row.outcome as CorporateEventFactorFetchOutcome,
      });
    }
    return result;
  }

  /**
   * AR-19 — idempotent on B3's own response. The fetch row is always
   * upserted (BR-008-29 needs "when was this issuer last attempted, and
   * what happened" regardless of outcome); factor rows are inserted only on
   * `ok`, with `ON CONFLICT DO NOTHING` on the table's natural key
   * (issuer, kind, last_date_prior, factor_published) — refetching the same
   * published event writes nothing new. A `failed` or `not_listed` outcome
   * never deletes a factor already stored (SPEC-008 BR-008-29: "a missing or
   * unreachable factor leaves the event unconfirmed rather than guessed" —
   * guessing here would mean discarding a confirmation that already holds).
   */
  async recordFetch(
    issuerCode: string,
    fetch: CorporateEventFactorFetch,
    fetchedAt: Date,
  ): Promise<void> {
    const failureCode = fetch.outcome === 'failed' ? fetch.failureCode : null;

    await this.db
      .insert(corporateEventFactorFetches)
      .values({ issuerCode, fetchedAt, outcome: fetch.outcome, failureCode })
      .onConflictDoUpdate({
        target: corporateEventFactorFetches.issuerCode,
        set: { fetchedAt, outcome: fetch.outcome, failureCode, updatedAt: new Date() },
      });

    if (fetch.outcome !== 'ok' || fetch.factors.length === 0) return;

    await this.db
      .insert(corporateEventFactors)
      .values(
        fetch.factors.map((factor) => ({
          id: uuidv7(),
          issuerCode: factor.issuerCode,
          kind: factor.kind,
          factorPublished: factor.factorPublished,
          lastDatePrior: factor.lastDatePrior,
          approvedOn: factor.approvedOn,
          source: SOURCE,
        })),
      )
      .onConflictDoNothing({
        target: [
          corporateEventFactors.issuerCode,
          corporateEventFactors.kind,
          corporateEventFactors.lastDatePrior,
          corporateEventFactors.factorPublished,
        ],
      });
  }
}

// AR-06/AR-07: `factor_published` is `text`, read back verbatim — never
// re-derived through a `number`. `factorMultiplier` is the one pure function
// (declared in the port) both this repository and the adapter call, so a
// stored row and a freshly-fetched one can never disagree on what the
// multiplier means.
function toDomainFactor(row: typeof corporateEventFactors.$inferSelect): CorporateEventFactor {
  const kind = row.kind as CorporateEventFactorKind;
  return {
    issuerCode: row.issuerCode,
    kind,
    factorPublished: row.factorPublished,
    multiplier: factorMultiplier(kind, row.factorPublished),
    lastDatePrior: BusinessDate.of(row.lastDatePrior),
    approvedOn: row.approvedOn ? BusinessDate.of(row.approvedOn) : null,
  };
}
