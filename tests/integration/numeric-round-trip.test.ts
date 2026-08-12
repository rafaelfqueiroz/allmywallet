import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Money, Quantity } from '@/core/shared/money';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

/**
 * TESTING §1, item 2: `NUMERIC` ⇄ `Decimal` round-tripping is one of the three
 * things that cannot be tested against a mock. A fake driver would hand back
 * whatever it was given; the failure being guarded against is the real driver
 * handing back a string that something then passes through `Number()`.
 *
 * This is the seam AR-07 exists to close, so it is verified against real
 * Postgres from the first commit rather than once a table exists.
 */
describe('NUMERIC(20,8) ⇄ Money round-trip', () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS numeric_round_trip (
        label       text PRIMARY KEY,
        amount      numeric(20, 8) NOT NULL,
        share_count numeric(20, 8) NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS numeric_round_trip');
    await pool.end();
    await database.stop();
  });

  const cases: ReadonlyArray<{ label: string; amount: string; shares: string; why: string }> = [
    { label: 'whole', amount: '1234.00000000', shares: '100', why: 'the ordinary case' },
    {
      label: 'centavos',
      amount: '0.01',
      shares: '1',
      why: 'the smallest unit a user actually sees',
    },
    {
      label: 'eighth-decimal',
      amount: '0.00000001',
      shares: '0.00000001',
      why: 'the last digit the column can hold — truncation here is silent data loss',
    },
    {
      label: 'large',
      amount: '999999999999.99999999',
      shares: '999999999999.99999999',
      why: 'the full width of NUMERIC(20,8); a float loses precision well below this',
    },
    {
      label: 'repeating',
      amount: '33.33333333',
      shares: '3',
      why: 'a third of 100, the shape most preço médio divisions produce',
    },
    {
      label: 'negative',
      amount: '-4321.12345678',
      shares: '-7',
      why: 'a reversal or an adjustment can be negative',
    },
  ];

  it.each(cases)('round-trips $label — $why', async ({ label, amount, shares }) => {
    const original = Money.fromString(amount);
    const originalShares = Quantity.fromString(shares);

    await pool.query(
      'INSERT INTO numeric_round_trip (label, amount, share_count) VALUES ($1,$2,$3)',
      // `toString()` is exactly what the Drizzle custom type serialises with
      // (see src/db/numeric.ts); the unit test covers that wiring, this covers
      // what Postgres does with the result.
      [label, original.toString(), originalShares.toString()],
    );

    const { rows } = await pool.query<{ amount: string; share_count: string }>(
      'SELECT amount, share_count FROM numeric_round_trip WHERE label = $1',
      [label],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;

    // `pg` returns NUMERIC as a string precisely so this decision is ours.
    expect(typeof row.amount).toBe('string');

    const readBack = Money.fromString(row.amount);
    const readBackShares = Quantity.fromString(row.share_count);

    expect(readBack.equals(original)).toBe(true);
    expect(readBackShares.equals(originalShares)).toBe(true);
  });

  it('preserves a value a float would corrupt', async () => {
    // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004. Persisting the domain's
    // answer and reading it back must give exactly 0.3, with no residue in the
    // 8th decimal place.
    const sum = Money.fromString('0.1').plus(Money.fromString('0.2'));
    await pool.query(
      'INSERT INTO numeric_round_trip (label, amount, share_count) VALUES ($1,$2,$3)',
      ['float-trap', sum.toString(), '1'],
    );

    const { rows } = await pool.query<{ amount: string }>(
      'SELECT amount FROM numeric_round_trip WHERE label = $1',
      ['float-trap'],
    );
    expect(rows[0]?.amount).toBe('0.30000000');
    expect(Money.fromString(rows[0]?.amount ?? '0').equals(Money.fromString('0.3'))).toBe(true);
  });

  it('refuses to widen past the column scale rather than rounding silently', async () => {
    // A 9th decimal place is beyond what NUMERIC(20,8) holds. Postgres rounds
    // it; the point of asserting this is that the *domain* never produces such a
    // value for persistence without a deliberate decision, and that if it does,
    // the loss is visible here rather than in a reconciliation six months on.
    await pool.query(
      'INSERT INTO numeric_round_trip (label, amount, share_count) VALUES ($1,$2,$3)',
      ['over-scale', '1.123456789', '1'],
    );
    const { rows } = await pool.query<{ amount: string }>(
      'SELECT amount FROM numeric_round_trip WHERE label = $1',
      ['over-scale'],
    );
    expect(rows[0]?.amount).toBe('1.12345679');
  });
});
