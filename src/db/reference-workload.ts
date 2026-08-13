import { BusinessDate } from '@/core/shared/clock';

/**
 * SPEC-016 TS-23 / BR-016-01: the reference workload every performance budget
 * is stated against — 100 assets, 10,000 transactions, 5 years of history.
 * "Loads in 2s" is unfalsifiable without a named scale (DL-016-02); this is
 * that scale, generated deterministically from a fixed seed so the numbers
 * `tests/performance/*.bench.ts` and `nightly.yml` produce are comparable
 * run over run rather than noise (TS-23).
 *
 * COUPLING (flagged for the #19 report and the orchestrator to track against
 * #9/#10): SPEC-006 (transactions, #9) and SPEC-007 (positions/average cost,
 * #10) are being built in parallel and own the tables this workload would
 * ultimately be inserted into. Neither exists in this migration set yet, so
 * this module is deliberately split into two halves:
 *
 *   1. Pure, deterministic *generation* of the 100 assets and 10,000
 *      transactions as plain descriptors — fully testable today, with no
 *      database at all (TS-01).
 *   2. `persistReferenceWorkload`, which seeds what already exists (a fixed
 *      reference user) and stops at the extension point marked below rather
 *      than inventing a schema for tables #9/#10 haven't shipped yet.
 *
 * Anchored to a fixed date, not `new Date()` — determinism must survive
 * being re-run on a different day, not just with the same seed.
 */

export const REFERENCE_ASSET_COUNT = 100;
export const REFERENCE_TRANSACTION_COUNT = 10_000;
export const REFERENCE_HISTORY_YEARS = 5;

/** BR-016-01's "as of" date. Fixed, not wall-clock — see the module doc above. */
export const REFERENCE_AS_OF_DATE = BusinessDate.of('2026-01-01');
export const REFERENCE_START_DATE = BusinessDate.of('2021-01-02');

/**
 * A fixed reference tenant, so `nightly.yml` can seed, measure and tear down
 * the same account run after run without colliding with any real user id
 * (AR-25's UUIDv7 ids are time-ordered but otherwise unconstrained, so a
 * fixed literal is as valid an id as a generated one).
 */
export const REFERENCE_USER_ID = '00000000-0000-7000-8000-000000000001';

/** TS-23's fixed seed. Changing this number changes every generated number below — never done casually. */
const REFERENCE_SEED = 0x5eed_016;

/**
 * mulberry32 — a small, dependency-free deterministic PRNG. Good enough for
 * fixture generation (not cryptography): the point is reproducibility across
 * runs and machines, not unpredictability.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SPEC PRD §1: the asset classes AllMyWallet consolidates. */
export type ReferenceAssetClass =
  'acao' | 'fii' | 'bdr' | 'etf' | 'tesouro_direto' | 'cdb' | 'lci' | 'lca';

const ASSET_CLASS_CYCLE: readonly ReferenceAssetClass[] = [
  'acao',
  'fii',
  'bdr',
  'etf',
  'tesouro_direto',
  'cdb',
  'lci',
  'lca',
];

export interface ReferenceAsset {
  readonly ticker: string;
  readonly assetClass: ReferenceAssetClass;
}

/**
 * 100 assets, deterministic. Cycles evenly through every asset class
 * (BR-016-03 requires every report to meet its budget "for any scope and
 * grouping combination" — a workload skewed toward one class would not
 * exercise grouping-by-asset-class at all) rather than drawing the class at
 * random, so the class distribution is stable across seed changes too.
 */
export function generateReferenceAssets(
  count: number = REFERENCE_ASSET_COUNT,
): readonly ReferenceAsset[] {
  const assets: ReferenceAsset[] = [];
  for (let i = 0; i < count; i++) {
    const assetClass = ASSET_CLASS_CYCLE[i % ASSET_CLASS_CYCLE.length];
    if (!assetClass) throw new Error('unreachable: modulo of a non-empty array');
    assets.push({ ticker: `REF${String(i).padStart(3, '0')}`, assetClass });
  }
  return assets;
}

export type ReferenceTransactionKind = 'buy' | 'sell';

/**
 * A structural descriptor, not the real domain `Transaction` (SPEC-006, #9 —
 * not built yet). Deliberately plain data rather than importing a type that
 * does not exist: the extension point below is where a future
 * `toTransaction()` mapping belongs, once #9 defines the shape to map into.
 */
export interface ReferenceTransaction {
  readonly ticker: string;
  readonly kind: ReferenceTransactionKind;
  readonly date: BusinessDate;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/**
 * 10,000 transactions spread evenly across `REFERENCE_HISTORY_YEARS` and
 * every generated asset, alternating buy-heavy toward the start of each
 * asset's history and mixing in sells later — enough shape for average-cost
 * and TWR/XIRR calculations to have something non-trivial to compute once
 * #9/#10 exist, without claiming to model realistic market behaviour.
 */
export function generateReferenceTransactions(
  assets: readonly ReferenceAsset[] = generateReferenceAssets(),
  count: number = REFERENCE_TRANSACTION_COUNT,
): readonly ReferenceTransaction[] {
  const rng = mulberry32(REFERENCE_SEED);
  const startMs = Date.parse(`${REFERENCE_START_DATE}T00:00:00Z`);
  const endMs = Date.parse(`${REFERENCE_AS_OF_DATE}T00:00:00Z`);
  const spanMs = endMs - startMs;

  // Dates and amounts are generated first, deliberately undecided on buy/sell
  // — "first transaction for a ticker is a buy" is a statement about
  // *chronological* order, not generation order, and this batch is not sorted
  // yet. Deciding kind before the sort below (as a first draft of this
  // function did) let a later-generated-but-earlier-dated sell slip in ahead
  // of its ticker's first buy once transactions were reordered by date.
  interface Draft {
    readonly ticker: string;
    readonly date: BusinessDate;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }
  const drafts: Draft[] = [];
  for (let i = 0; i < count; i++) {
    const asset = assets[i % assets.length];
    if (!asset) throw new Error('unreachable: modulo of a non-empty array');

    // Deterministic day offset from the seeded RNG — same seed, same date
    // every run, regardless of when the seeder itself is executed.
    const offsetMs = Math.floor(rng() * spanMs);
    const date = new Date(startMs + offsetMs).toISOString().slice(0, 10);

    drafts.push({
      ticker: asset.ticker,
      date: BusinessDate.of(date),
      quantity: 1 + Math.floor(rng() * 100),
      // Cents, not a float price — AR-06 applies just as much to a fixture
      // generator as to production code; the eventual `toTransaction()`
      // mapping is what turns this into a `Money`/`Decimal` value.
      unitPriceCents: 100 + Math.floor(rng() * 50_000),
    });
  }

  drafts.sort((a, b) => BusinessDate.compare(a.date, b.date));

  const seenTickers = new Set<string>();
  return drafts.map((draft): ReferenceTransaction => {
    // The first transaction against a given ticker, in date order, is always
    // a buy — nothing can be sold before it has been bought (mirrors
    // SPEC-007's own constraint, so the generated history is at least
    // internally valid).
    const isFirstForTicker = !seenTickers.has(draft.ticker);
    seenTickers.add(draft.ticker);
    const kind: ReferenceTransactionKind = isFirstForTicker || rng() > 0.3 ? 'buy' : 'sell';
    return { ...draft, kind };
  });
}

export interface ReferenceWorkload {
  readonly assets: readonly ReferenceAsset[];
  readonly transactions: readonly ReferenceTransaction[];
}

export function generateReferenceWorkload(): ReferenceWorkload {
  const assets = generateReferenceAssets();
  const transactions = generateReferenceTransactions(assets);
  return { assets, transactions };
}
