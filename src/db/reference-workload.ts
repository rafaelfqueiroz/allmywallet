import { BusinessDate } from '@/core/shared/clock';
import { TransactionId } from '@/core/shared/ids';
import type { AssetId, UserId } from '@/core/shared/ids';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { computeTotalValue } from '@/core/ledger/transaction';
import type { transactions } from '@/db/schema/transactions';

/**
 * SPEC-016 TS-23 / BR-016-01: the reference workload every performance budget
 * is stated against — 100 assets, 10,000 transactions, 5 years of history.
 * "Loads in 2s" is unfalsifiable without a named scale (DL-016-02); this is
 * that scale, generated deterministically from a fixed seed so the numbers
 * `tests/performance/*.bench.ts` and `nightly.yml` produce are comparable
 * run over run rather than noise (TS-23).
 *
 * The module stays split in two halves, and the split is still worth having
 * now that the tables exist:
 *
 *   1. Pure, deterministic *generation* of the 100 assets and 10,000
 *      transactions as plain descriptors — fully testable with no database at
 *      all (TS-01), which is what `tests/performance/reference-workload.test.ts`
 *      asserts determinism against.
 *   2. `seed-reference.ts`, the persistence entrypoint, which maps those
 *      descriptors onto SPEC-006's real `assets` and `transactions` rows.
 *
 * The descriptors deliberately remain plain data rather than becoming
 * `Transaction` values here: generation must stay a pure function of the seed,
 * and a `Transaction` carries ids and timestamps that persistence owns.
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
 * A structural descriptor, not the real domain `Transaction`. See the module
 * doc: keeping this plain is what keeps generation a pure function of the
 * seed. `seed-reference.ts` maps it onto the real row.
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

  /**
   * Kind is decided walking the sorted drafts in date order, tracking the
   * running quantity per ticker — because the history has to be **replayable**,
   * not merely plausible.
   *
   * "The first row for a ticker is a buy" was the original rule and it is not
   * enough: it stops a sale before the first purchase and does nothing about
   * the fourth sale of 90 against a holding of 30. `pnpm positions:rebuild`
   * on the seeded reference tenant refused with `INSUFFICIENT_QUANTITY`,
   * which is SPEC-007 correctly declining to replay a ledger that cannot
   * exist. A performance fixture the position engine rejects is not a
   * fixture — every budget measured against it would be measuring a dataset
   * no report could ever be produced from.
   *
   * A sale is therefore capped at what is actually held, and a ticker holding
   * nothing can only buy. Both decisions consume the same RNG stream in the
   * same order as before, so the workload stays a pure function of the seed.
   */
  const held = new Map<string, number>();
  return drafts.map((draft): ReferenceTransaction => {
    const holding = held.get(draft.ticker) ?? 0;
    const wantsSell = holding > 0 && rng() <= 0.3;

    if (!wantsSell) {
      held.set(draft.ticker, holding + draft.quantity);
      return { ...draft, kind: 'buy' };
    }

    const quantity = Math.min(draft.quantity, holding);
    held.set(draft.ticker, holding - quantity);
    return { ...draft, quantity, kind: 'sell' };
  });
}

export interface ReferenceWorkload {
  readonly assets: readonly ReferenceAsset[];
  readonly transactions: readonly ReferenceTransaction[];
}

/**
 * The workload's asset classes are the PRD's Portuguese vocabulary; the
 * `assets.class` CHECK (SPEC-006, `db/schema/assets.ts`) is the English
 * `ASSET_CLASSES` list. `acao` is the only one that differs, and mapping it
 * here — rather than renaming either list — keeps the generated fixture stable
 * across a seed change while letting the schema keep its own vocabulary.
 */
export const REFERENCE_ASSET_CLASS_TO_SCHEMA: Readonly<Record<ReferenceAssetClass, string>> = {
  acao: 'stock',
  fii: 'fii',
  bdr: 'bdr',
  etf: 'etf',
  tesouro_direto: 'tesouro_direto',
  cdb: 'cdb',
  lci: 'lci',
  lca: 'lca',
};

/**
 * Cents to a plain decimal literal, by integer arithmetic only — never
 * `cents / 100`, which is a float the moment the division happens (AR-06).
 * The result is a string, which is the only thing `Money.fromString` accepts.
 */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function generateReferenceWorkload(): ReferenceWorkload {
  const assets = generateReferenceAssets();
  const transactions = generateReferenceTransactions(assets);
  return { assets, transactions };
}

/**
 * The descriptors, mapped onto SPEC-006's real `transactions` rows.
 *
 * Pure, and here rather than in `seed-reference.ts`, because three callers
 * need identical rows and only one of them is the seeder: the blocking
 * pagination test (`tests/integration/transaction-pagination.test.ts`) builds
 * its 10.000 rows this way so that what CI proves correct is the same shape
 * the nightly run measures, and the nightly run in turn measures what the
 * seeder wrote. A second mapping would let "correct at scale" and "fast at
 * scale" quietly be statements about two different datasets.
 *
 * Built through `naturalKeyFor` and `computeTotalValue` rather than by hand,
 * so a fixture can never disagree with the ledger about what a natural key or
 * a total value is.
 */
export function referenceTransactionRows(
  referenceTransactions: readonly ReferenceTransaction[],
  assetIds: ReadonlyMap<string, AssetId>,
  userId: UserId,
): (typeof transactions.$inferInsert)[] {
  return referenceTransactions.map((transaction, index) => {
    const assetId = assetIds.get(transaction.ticker);
    if (assetId === undefined) {
      throw new Error(`referenceTransactionRows: no asset id for ${transaction.ticker}`);
    }

    const quantity = Quantity.fromString(String(transaction.quantity));
    const unitPrice = Money.fromString(centsToDecimalString(transaction.unitPriceCents));
    const fees = Money.zero();
    const tradeDate = transaction.date;

    return {
      id: TransactionId.generate(),
      userId,
      assetId,
      // No institution: the workload models scale, not custody, and a null
      // institution is a legitimate bucket rather than a gap (BR-007-08).
      institutionId: null,
      type: transaction.kind,
      status: 'active',
      tradeDate,
      quantity,
      unitPrice,
      fees,
      totalValue: computeTotalValue(transaction.kind, quantity, unitPrice, fees),
      ratio: null,
      /**
       * BR-006-04's key, computed the way the ledger computes it — with the
       * index appended, because the generator can legitimately produce two
       * identical rows for one ticker on one day and `(natural_key,
       * occurrence)` is unique. The index rather than a running duplicate
       * count keeps the mapping a pure function of position, so a re-run
       * produces the same keys for the same workload.
       */
      naturalKey: `${naturalKeyFor({
        assetId,
        institutionId: null,
        type: transaction.kind,
        tradeDate,
        quantity,
        unitPrice,
      })}|ref-${index}`,
      occurrence: 1,
      importBatchId: null,
      isManual: false,
      isUserModified: false,
    };
  });
}
