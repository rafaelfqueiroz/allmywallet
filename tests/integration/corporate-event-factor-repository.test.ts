import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { BusinessDate } from '@/core/shared/clock';
import { Quantity } from '@/core/shared/money';
import { DrizzleCorporateEventFactorRepository } from '@/adapters/db/corporate-event-factor-repository';
import type { CorporateEventFactor } from '@/core/quotes/corporate-event-factors';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * SPEC-008 BR-008-29 (#113) — `DrizzleCorporateEventFactorRepository` over
 * the two shared, RLS-exempt tables from migration 0021
 * (`corporate_event_factors`, `corporate_event_factor_fetches`; see
 * `tests/integration/corporate-event-factors-migration.test.ts` for the
 * CHECK/RLS-exemption coverage — this file is the repository's own
 * round-trip and idempotency behaviour). TESTING §1: AR-19 idempotency and
 * NUMERIC ⇄ Money/Quantity round-tripping cannot be proven against a mock.
 */
describe('DrizzleCorporateEventFactorRepository (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const grupamento: CorporateEventFactor = {
    issuerCode: 'MGLU',
    kind: 'grupamento',
    factorPublished: '0.1',
    multiplier: Quantity.fromString('0.1'),
    lastDatePrior: BusinessDate.of('2024-05-24'),
    approvedOn: BusinessDate.of('2024-04-24'),
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.appUrl, max: 1 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    // TS-33/TS-34: both tables are shared/global (no tenant to scope them),
    // so cleanup here — not just in beforeEach — protects whatever runs
    // after this file in a reused database.
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query(
        'TRUNCATE corporate_event_factors, corporate_event_factor_fetches RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
    await pool.end();
    await database.stop();
  });

  // TS-03: order-agnostic against a reused database — reset before every
  // test, not just once in beforeAll.
  beforeEach(async () => {
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query(
        'TRUNCATE corporate_event_factors, corporate_event_factor_fetches RESTART IDENTITY CASCADE',
      );
    } finally {
      await migratorPool.end();
    }
  });

  it('recordFetch(ok) then listByIssuers round-trips the factor, including Quantity/BusinessDate', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    await repo.recordFetch(
      'MGLU',
      { outcome: 'ok', factors: [grupamento] },
      new Date('2026-03-16T12:00:00Z'),
    );

    const byIssuer = await repo.listByIssuers(['MGLU']);
    const factors = byIssuer.get('MGLU');
    expect(factors).toHaveLength(1);
    expect(factors?.[0]?.factorPublished).toBe('0.1');
    expect(factors?.[0]?.multiplier.equals(Quantity.fromString('0.1'))).toBe(true);
    expect(factors?.[0]?.lastDatePrior).toBe('2024-05-24');
    expect(factors?.[0]?.approvedOn).toBe('2024-04-24');

    expect(await repo.listByIssuers(['UNKNOWN'])).toEqual(new Map());
    expect(await repo.listByIssuers([])).toEqual(new Map());
  });

  it('AR-19: refetching the identical ok outcome writes no new factor row', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    const fetchedAt = new Date('2026-03-16T12:00:00Z');

    await repo.recordFetch('MGLU', { outcome: 'ok', factors: [grupamento] }, fetchedAt);
    await repo.recordFetch('MGLU', { outcome: 'ok', factors: [grupamento] }, fetchedAt);

    const factors = await repo.listByIssuers(['MGLU']);
    expect(factors.get('MGLU')).toHaveLength(1);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM corporate_event_factors',
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('AR-19, run twice: idempotency holds across repeated test-suite runs against a reused database', async () => {
    // The same assertion as above, alone in its own test — the dispatch
    // brief requires this integration file to be run twice in a row against
    // the reused amw-ci-postgres container; this test's own beforeEach
    // truncation is what makes the second run see a clean slate rather than
    // a stale "2" from a previous pass that never reset.
    const repo = new DrizzleCorporateEventFactorRepository(db);
    const fetchedAt = new Date('2026-03-16T12:00:00Z');

    await repo.recordFetch('MGLU', { outcome: 'ok', factors: [grupamento] }, fetchedAt);
    await repo.recordFetch('MGLU', { outcome: 'ok', factors: [grupamento] }, fetchedAt);
    await repo.recordFetch('MGLU', { outcome: 'ok', factors: [grupamento] }, fetchedAt);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM corporate_event_factors',
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('BR-008-29: a failed fetch after an ok one keeps the stored factor but leaves it unconfirmed', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    await repo.recordFetch(
      'MGLU',
      { outcome: 'ok', factors: [grupamento] },
      new Date('2026-03-10T12:00:00Z'),
    );
    await repo.recordFetch(
      'MGLU',
      { outcome: 'failed', failureCode: 'timeout' },
      new Date('2026-03-16T12:00:00Z'),
    );

    const factors = await repo.listByIssuers(['MGLU']);
    expect(factors.get('MGLU')).toBeUndefined();

    const { rows: storedRows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM corporate_event_factors WHERE issuer_code = 'MGLU'",
    );
    expect(storedRows[0]?.count).toBe(1);

    const lastFetches = await repo.lastFetches(['MGLU']);
    expect(lastFetches.get('MGLU')?.outcome).toBe('failed');
    expect(lastFetches.get('MGLU')?.fetchedAt.toISOString()).toBe('2026-03-16T12:00:00.000Z');
  });

  it('a not_listed outcome writes no factor row and is reported by lastFetches', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    await repo.recordFetch('HGLG', { outcome: 'not_listed' }, new Date('2026-03-16T12:00:00Z'));

    expect(await repo.listByIssuers(['HGLG'])).toEqual(new Map());
    const lastFetches = await repo.lastFetches(['HGLG']);
    expect(lastFetches.get('HGLG')?.outcome).toBe('not_listed');
  });

  it('lastFetches: empty input returns empty, unknown issuers are simply absent', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    await repo.recordFetch(
      'MGLU',
      { outcome: 'ok', factors: [] },
      new Date('2026-03-16T12:00:00Z'),
    );

    expect(await repo.lastFetches([])).toEqual(new Map());
    const result = await repo.lastFetches(['MGLU', 'UNKNOWN']);
    expect([...result.keys()]).toEqual(['MGLU']);
  });

  it('recordFetch upserts the fetch row rather than duplicating it (one row per issuer)', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    await repo.recordFetch(
      'MGLU',
      { outcome: 'ok', factors: [] },
      new Date('2026-03-10T12:00:00Z'),
    );
    await repo.recordFetch(
      'MGLU',
      { outcome: 'ok', factors: [] },
      new Date('2026-03-16T12:00:00Z'),
    );

    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM corporate_event_factor_fetches WHERE issuer_code = 'MGLU'",
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('records a successful fetch marker and its factors atomically', async () => {
    const repo = new DrizzleCorporateEventFactorRepository(db);
    const invalid = { ...grupamento, kind: 'invalid-kind' as CorporateEventFactor['kind'] };

    await expect(
      repo.recordFetch(
        'MGLU',
        { outcome: 'ok', factors: [invalid] },
        new Date('2026-03-16T12:00:00Z'),
      ),
    ).rejects.toThrow();

    // The factor table's CHECK rejects the second write. The fetch marker
    // must roll back with it, otherwise a later commit sees a false `ok`.
    expect(await repo.lastFetches(['MGLU'])).toEqual(new Map());
    expect(await repo.listByIssuers(['MGLU'])).toEqual(new Map());
  });
});
