import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { UserId, type AssetId, type InstitutionId } from '@/core/shared/ids';
import type { Money } from '@/core/shared/money';
import { withReportPort } from '@/app/(app)/reports/data';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { seedAsset, seedInstitution } from '../support/ledger-fixtures';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * SPEC-011 BR-011-15 / SPEC-009 — **the report reports market value.**
 *
 * This file exists because of a defect that every other test in the suite was
 * blind to. `listValuedPositions` returned `total_cost` as `value`, flagged
 * every row `estimated: true`, and ignored its `asOf` argument entirely. The
 * reporting-framework suite passed throughout, because its fixtures seed no
 * quotes — with no price to find, a correct implementation *also* falls back
 * to cost, so cost-as-value and value-as-value are indistinguishable there.
 *
 * The distinguishing fixture is the one thing those tests lacked: a position
 * whose market price differs from what was paid for it.
 *
 * TS-03/TS-34: the database is shared across suite files in CI, and
 * `assets`, `price_quotes` and `latest_quotes` are **global, non-tenant**
 * rows — exactly the kind that leak. Truncated in both `beforeAll` and
 * `afterAll`.
 */
describe('SPEC-011 — report holdings are valued at market (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const ASOF = BusinessDate.of('2026-03-20');

  let petr: AssetId;
  let cdb: AssetId;
  let xp: InstitutionId;
  let rico: InstitutionId;

  async function cleanUp(): Promise<void> {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    const pool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await pool.query(
        'TRUNCATE index_series, price_quotes, latest_quotes, fixed_income_contracts, assets RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    await cleanUp();
    await seedUser(database.migrationUrl, userId);

    petr = (await seedAsset(database.migrationUrl, 'PETR4', 'Petrobras PN')).id;
    cdb = (await seedAsset(database.migrationUrl, 'CDB-BANCO-X', 'CDB 110% CDI', 'cdb')).id;
    xp = await seedInstitution(database.migrationUrl, 'XP Investimentos');
    rico = await seedInstitution(database.migrationUrl, 'Rico');

    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await migratorPool?.end();
    await cleanUp();
    await database.stop();
  });

  beforeEach(async () => {
    await migratorPool.query('TRUNCATE positions CASCADE');
    await migratorPool.query('TRUNCATE price_quotes, latest_quotes CASCADE');
  });

  async function seedPosition(
    assetId: AssetId,
    institutionId: InstitutionId | null,
    quantity: string,
    averageCost: string,
    totalCost: string,
  ): Promise<void> {
    await migratorPool.query(
      `INSERT INTO positions (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0)`,
      [userId, assetId, institutionId, quantity, averageCost, totalCost],
    );
  }

  async function seedClose(assetId: AssetId, date: string, close: string): Promise<void> {
    await migratorPool.query(
      `INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, 'test')`,
      [assetId, date, close],
    );
  }

  const to8 = (value: Money): string => value.toDecimal().toFixed(8);

  /**
   * **The regression test for the seam.** 100 PETR4 bought at 32,15 and worth
   * 38,42 on the as-of date:
   *
   *   cost   = 100 × 32,15 = 3.215,00
   *   market = 100 × 38,42 = 3.842,00
   *
   * The old implementation returned 3.215,00 as `value`. The two figures are
   * deliberately far apart, so no rounding tolerance can hide a regression.
   */
  it('values a listed holding at its close, not at what was paid for it', async () => {
    await seedPosition(petr, xp, '100', '32.15', '3215');
    await seedClose(petr, '2026-03-20', '38.42');

    const positions = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(to8(position.value)).toBe('3842.00000000');
    expect(to8(position.costBasis)).toBe('3215.00000000');
    // BR-011-15: an observed close is not an estimate. Marking every row was
    // what made the badge meaningless.
    expect(position.estimated).toBe(false);
  });

  /**
   * BR-009-02 — `asOf` is honoured rather than ignored. The two dates carry
   * different closes, so a function that discarded the argument (as the old
   * one did) cannot produce both answers.
   */
  it('answers for the date it is asked about', async () => {
    await seedPosition(petr, xp, '100', '32.15', '3215');
    await seedClose(petr, '2026-03-19', '35.00');
    await seedClose(petr, '2026-03-20', '38.42');

    const onThe19th = await withReportPort(userId, (port) =>
      port.listValuedPositions(BusinessDate.of('2026-03-19')),
    );
    const onThe20th = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    expect(to8(onThe19th[0]!.value)).toBe('3500.00000000');
    expect(to8(onThe20th[0]!.value)).toBe('3842.00000000');
  });

  /**
   * BR-009-03 — a close is carried forward across a day with no quote, and
   * that is *not* an estimate: it is an observed price, just an older one.
   */
  it('carries the last close forward rather than falling back to cost', async () => {
    await seedPosition(petr, xp, '100', '32.15', '3215');
    await seedClose(petr, '2026-03-18', '36.00');

    const positions = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    expect(to8(positions[0]!.value)).toBe('3600.00000000');
    expect(positions[0]!.estimated).toBe(false);
  });

  /**
   * TS-12's cross-report invariant, at the level it actually depends on: the
   * report groups by institution, so the same asset arrives as two rows. They
   * must sum to what one row of the combined quantity would be worth.
   */
  it('keeps a split holding per institution, and the parts sum to the whole', async () => {
    await seedPosition(petr, xp, '60', '32.15', '1929');
    await seedPosition(petr, rico, '40', '30.00', '1200');
    await seedClose(petr, '2026-03-20', '38.42');

    const positions = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    expect(positions).toHaveLength(2);
    // Institutions are carried across by position, so a shift would attribute
    // holdings to the wrong broker — asserted, not assumed.
    expect(new Set(positions.map((p) => p.institutionId))).toEqual(new Set([xp, rico]));

    const total = positions.reduce(
      (sum, p) => sum.plus(p.value),
      positions[0]!.value.minus(positions[0]!.value),
    );
    expect(to8(total)).toBe('3842.00000000');
  });

  /**
   * BR-009-13 / DL-009-05 — bank paper with no contract cannot be accrued, so
   * it falls back to cost. That row *is* an estimate, and this is the case the
   * old implementation happened to get right for the wrong reason: it marked
   * every row estimated, including the ones that were not.
   */
  it('falls back to cost for unpriceable bank paper, and marks only that row', async () => {
    await seedPosition(petr, xp, '100', '32.15', '3215');
    await seedPosition(cdb, xp, '1', '10000', '10000');
    await seedClose(petr, '2026-03-20', '38.42');

    const positions = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    const listed = positions.find((p) => p.assetId === petr)!;
    const paper = positions.find((p) => p.assetId === cdb)!;

    expect(to8(listed.value)).toBe('3842.00000000');
    expect(listed.estimated).toBe(false);

    expect(to8(paper.value)).toBe('10000.00000000');
    expect(to8(paper.costBasis)).toBe('10000.00000000');
    expect(paper.estimated).toBe(true);
  });

  it('omits a position closed to zero rather than pricing it', async () => {
    // SPEC-007's `positions_closed_reset_check`: a position closed to zero
    // resets its cost columns too, so the fixture has to be a genuinely closed
    // position rather than a zero quantity with cost left behind.
    await seedPosition(petr, xp, '0', '0', '0');
    await seedClose(petr, '2026-03-20', '38.42');

    const positions = await withReportPort(userId, (port) => port.listValuedPositions(ASOF));

    expect(positions).toHaveLength(0);
  });
});
