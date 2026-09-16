import type { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';

/**
 * SPEC-008 BR-008-29 (#113) — B3's published share-ratio factor for a split
 * (*desdobramento*), reverse split (*grupamento*) or bonus (*bonificação*).
 *
 * Read from B3's public listed-companies data — no key, no credential, no user
 * data sent (SPEC-003 BR-003-08) — by issuer, persisted and shared across
 * tenants like quotes (BR-008-25). It **only confirms** a ratio derived from
 * custody data (SPEC-007 BR-007-04a); nothing here creates, moves or
 * classifies a transaction.
 *
 * AR-01/AR-02: the port is declared here; `adapters/market-data/` fetches,
 * `adapters/db/corporate-event-factor-repository.ts` stores.
 */

export const CORPORATE_EVENT_FACTOR_KINDS = ['desdobramento', 'grupamento', 'bonificacao'] as const;
export type CorporateEventFactorKind = (typeof CORPORATE_EVENT_FACTOR_KINDS)[number];

export interface CorporateEventFactor {
  /** B3's issuer code — `MGLU`, `KLBN` — not a ticker: no class (ON/PN/unit). */
  readonly issuerCode: string;
  readonly kind: CorporateEventFactorKind;
  /**
   * The factor as B3 published it, `.`-decimal (`0.1`, `300`, `5`). Kept
   * verbatim, not at NUMERIC(20,8): B3 states some factors past eight places,
   * which is exactly what `not_representable` must be able to see.
   */
  readonly factorPublished: string;
  /** `factorMultiplier(kind, factorPublished)` — shares after = shares before × multiplier. */
  readonly multiplier: Quantity;
  /** B3's *última data com*: the last date a holder is entitled to the event. */
  readonly lastDatePrior: BusinessDate;
  readonly approvedOn: BusinessDate | null;
}

/**
 * BR-008-29 — "factor semantics differ by event type". A grupamento factor is
 * a **multiplier** (`0.1` = 10:1); a desdobramento or bonificação factor is a
 * **percentage added** (`300` → ×4, `5` → ×1,05). One pure function, so the
 * adapter normalising B3's response and the repository reading a stored row
 * cannot disagree.
 *
 * Exact decimal arithmetic (AR-06/AR-10): the input is a string, never a
 * `number`.
 */
export function factorMultiplier(
  kind: CorporateEventFactorKind,
  factorPublished: string,
): Quantity {
  const published = Quantity.fromString(factorPublished);
  return kind === 'grupamento'
    ? published
    : Quantity.fromString('1').plus(published.dividedBy('100'));
}

export const CORPORATE_EVENT_FACTOR_FETCH_OUTCOMES = ['ok', 'not_listed', 'failed'] as const;
export type CorporateEventFactorFetchOutcome =
  (typeof CORPORATE_EVENT_FACTOR_FETCH_OUTCOMES)[number];

/** What one call to B3 for one issuer produced. */
export type CorporateEventFactorFetch =
  | { readonly outcome: 'ok'; readonly factors: readonly CorporateEventFactor[] }
  /** B3 does not list the issuer — every FII, for one (they are not listed companies). */
  | { readonly outcome: 'not_listed' }
  /** Timeout, HTTP error or a response that could not be read. `failureCode` is a code, never a body. */
  | { readonly outcome: 'failed'; readonly failureCode: string };

/** The external source: B3's listed-companies endpoint, one issuer per call. */
export interface CorporateEventFactorSource {
  fetchIssuer(issuerCode: string): Promise<CorporateEventFactorFetch>;
}

export interface CorporateEventFactorFetchRecord {
  readonly issuerCode: string;
  readonly fetchedAt: Date;
  readonly outcome: CorporateEventFactorFetchOutcome;
}

/**
 * The read port commit resolution needs (SPEC-005 BR-005-20b): every stored
 * factor of the given issuers. An issuer with none is absent from the map.
 */
export interface CorporateEventFactorReader {
  listByIssuers(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly CorporateEventFactor[]>>;
}

/** The shared tables `corporate_event_factors` and `corporate_event_factor_fetches`. */
export interface CorporateEventFactorStore extends CorporateEventFactorReader {
  lastFetches(
    issuerCodes: readonly string[],
  ): Promise<ReadonlyMap<string, CorporateEventFactorFetchRecord>>;
  /**
   * Records one fetch's outcome and, when `ok`, its factors — idempotent on
   * B3's own response (AR-19): refetching the same events writes nothing new.
   * A `failed` or `not_listed` fetch never deletes factors already stored.
   */
  recordFetch(issuerCode: string, fetch: CorporateEventFactorFetch, fetchedAt: Date): Promise<void>;
}
