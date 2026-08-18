import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { AssetId, UserId } from '@/core/shared/ids';
import { listTransactions } from '@/core/ledger/list-transactions';
import { DrizzleTransactionRepository } from '@/adapters/db/transaction-repository';
import { PAGE_SIZE, paginationFor } from '@/lib/transactions-url-state';
import {
  REFERENCE_ASSET_CLASS_TO_SCHEMA,
  REFERENCE_TRANSACTION_COUNT,
  generateReferenceWorkload,
  referenceTransactionRows,
} from '@/db/reference-workload';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-006's first acceptance criterion — "the transaction list paginates
 * correctly over 10,000+ rows" — as a **blocking** test.
 *
 * The budget half of that criterion is nightly and advisory (DL-016-03), and
 * this is the cheap check that predicts it: correctness at scale is the thing
 * a per-PR gate can actually hold, and it is where the real defect lives. Over
 * 200 pages, a tie in the ORDER BY is not a cosmetic wobble — one row is shown
 * twice and another is never shown at all, and no test over four rows can see
 * it. `transaction-repository.test.ts` checks the same property over two
 * pages; this one checks it over every page there is.
 *
 * The rows are SPEC-016's reference workload, built through the same
 * `referenceTransactionRows` the nightly seeder uses, so "correct at scale"
 * and "fast at scale" are statements about one dataset rather than two.
 */
describe('SPEC-006 — the list over 10.000+ rows (integration)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await applyMigrations(testDb.migrationUrl);
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await seedUser(testDb.migrationUrl, userId);

    const workload = generateReferenceWorkload();

    const migratorPool = new Pool({ connectionString: testDb.migrationUrl, max: 1 });
    const assetIds = new Map<string, AssetId>();
    try {
      for (const asset of workload.assets) {
        const { rows } = await migratorPool.query<{ id: string }>(
          `INSERT INTO assets (id, code, name, class) VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [
            asset.ticker,
            `Reference ${asset.ticker}`,
            REFERENCE_ASSET_CLASS_TO_SCHEMA[asset.assetClass],
          ],
        );
        const id = rows[0]?.id;
        if (id === undefined) throw new Error(`no id for ${asset.ticker}`);
        assetIds.set(asset.ticker, AssetId.of(id));
      }
    } finally {
      await migratorPool.end();
    }

    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    appDb = drizzle(appPool, { schema });

    const rows = referenceTransactionRows(workload.transactions, assetIds, userId);
    await withTenant(
      userId,
      async (tx) => {
        // Chunked, so one statement never carries ten thousand rows of
        // parameters — the same shape `seed-reference.ts` uses.
        for (let start = 0; start < rows.length; start += 500) {
          await tx.insert(schema.transactions).values(rows.slice(start, start + 500));
        }
      },
      appDb,
    );
  }, 300_000);

  afterAll(async () => {
    await resetLedger(testDb.migrationUrl);
    await resetUsers(testDb.migrationUrl);
    await appPool.end();
    await testDb.stop();
  });

  async function pageAt(page: number) {
    return withTenant(
      userId,
      (tx) =>
        listTransactions(new DrizzleTransactionRepository(tx, userId), {}, paginationFor(page)),
      appDb,
    );
  }

  it('reports the whole ledger as the total, not the page', async () => {
    const first = await pageAt(1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.total).toBe(REFERENCE_TRANSACTION_COUNT);
    expect(first.value.items).toHaveLength(PAGE_SIZE);
  });

  it('walks every page and shows each row exactly once', async () => {
    const pageCount = Math.ceil(REFERENCE_TRANSACTION_COUNT / PAGE_SIZE);
    const seen = new Set<string>();

    for (let page = 1; page <= pageCount; page++) {
      const result = await pageAt(page);
      expect(result.ok, `page ${page} failed`).toBe(true);
      if (!result.ok) return;
      for (const item of result.value.items) {
        /**
         * Completeness across every page: the offset arithmetic, the total,
         * and the absence of gaps or repeats. This is the assertion that
         * catches an off-by-one in `paginationFor` or a `total` computed over
         * the page instead of the match.
         *
         * It is a *guard* against a non-total ordering rather than a proof of
         * one — Postgres's sort is deterministic for a given plan, so removing
         * the id tiebreak does not reliably reproduce here. The proof is the
         * next test, which asserts the ordering key itself.
         */
        expect(seen.has(item.transaction.id), `row ${item.transaction.id} shown twice`).toBe(false);
        seen.add(item.transaction.id);
      }
    }

    expect(seen.size).toBe(REFERENCE_TRANSACTION_COUNT);
  });

  /**
   * BR-006-07's ordering, asserted as a **total** order rather than as "newest
   * first" — which is the part that actually matters over 200 pages.
   *
   * The whole reference workload is inserted in one transaction, so every row
   * shares a `created_at`: `now()` is transaction time, not statement time.
   * That makes the id the only thing separating two rows traded on the same
   * day, and there are 10.000 rows over ~1.800 dates, so same-day ties are the
   * common case rather than an edge one. If the id ever leaves the ORDER BY,
   * the sequence below stops being monotonic and this fails — where a
   * page-by-page completeness check would not, because Postgres still returns
   * *a* stable order, just not one the offsets can rely on across plan changes.
   */
  it('returns a total order — every consecutive pair strictly decreasing', async () => {
    const pageCount = Math.ceil(REFERENCE_TRANSACTION_COUNT / PAGE_SIZE);
    const keys: string[] = [];

    for (let page = 1; page <= pageCount; page++) {
      const result = await pageAt(page);
      if (!result.ok) throw new Error(`page ${page} failed`);
      for (const item of result.value.items) {
        keys.push(`${item.transaction.tradeDate}|${item.transaction.id}`);
      }
    }

    for (let i = 1; i < keys.length; i++) {
      const previous = keys[i - 1] ?? '';
      const current = keys[i] ?? '';
      expect(previous > current, `order broken between rows ${i - 1} and ${i}`).toBe(true);
    }
  });

  it('orders newest first across the whole ledger, not just within a page', async () => {
    const first = await pageAt(1);
    const last = await pageAt(Math.ceil(REFERENCE_TRANSACTION_COUNT / PAGE_SIZE));
    expect(first.ok && last.ok).toBe(true);
    if (!first.ok || !last.ok) return;

    const newest = first.value.items[0]?.transaction.tradeDate;
    const oldest = last.value.items.at(-1)?.transaction.tradeDate;
    expect(newest).toBeDefined();
    expect(oldest).toBeDefined();
    expect(String(newest) > String(oldest)).toBe(true);
  });

  it('serves a page past the end as empty rather than failing', async () => {
    const beyond = await pageAt(Math.ceil(REFERENCE_TRANSACTION_COUNT / PAGE_SIZE) + 5);
    expect(beyond.ok).toBe(true);
    if (!beyond.ok) return;
    expect(beyond.value.items).toEqual([]);
    // The total still describes the ledger, so the pagination control can say
    // "page 205 of 200" rather than "0 transactions".
    expect(beyond.value.total).toBe(REFERENCE_TRANSACTION_COUNT);
  });
});
