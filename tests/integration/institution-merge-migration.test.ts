import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { AssetId, InstitutionId, UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { rebuildForTenant } from '@/ops/rebuild-positions';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0024_merge_institution_spellings.sql` (#136).
 *
 * B3 spells one institution several ways across extracts and periods, and each
 * spelling became its own row — so one real custody location was two positions
 * (SPEC-007 BR-007-08) and every rule keyed on the position read half of its
 * history. These tests run the migration against a database already holding
 * the split, which is the only state that matters: the owner's.
 */
describe('migration 0024 — institution spellings (integration)', () => {
  const INTER_FULL = 'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA';
  const INTER_SHORT = 'INTER DTVM LTDA';
  const XP_FULL = 'XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A';
  const XP_CCTVM = 'XP INVESTIMENTOS CCTVM S/A';
  const XP_TRUNCATED = 'XP INVESTIMENTOS CORRETORA DE CAMBIO, TITULOS E VALORES MOBI';
  const CLEAR = 'CLEAR CORRETORA - GRUPO XP';
  const BANCO_INTER = 'BANCO INTER S/A';

  let database: TestDatabase;
  let migratorPool: Pool;
  let appPool: Pool;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const userId = UserId.generate();
  let assetId: string;

  const migration = async () =>
    migratorPool.query(
      await readFile(
        join(process.cwd(), 'src/db/migrations/0024_merge_institution_spellings.sql'),
        'utf8',
      ),
    );

  const institutionsNow = async (): Promise<{ id: string; name: string }[]> =>
    (await migratorPool.query('SELECT id, name FROM institutions ORDER BY name')).rows as {
      id: string;
      name: string;
    }[];

  const addInstitution = async (name: string): Promise<string> => {
    const id = randomUUID();
    await migratorPool.query('INSERT INTO institutions (id, name) VALUES ($1, $2)', [id, name]);
    return id;
  };

  /** A buy, written the way the importer writes one — key included (BR-005-14). */
  const addBuy = async (
    institutionId: string,
    tradeDate: string,
    quantity: string,
    unitPrice: string,
    occurrence = 1,
  ): Promise<{ id: string; naturalKey: string }> => {
    const id = randomUUID();
    const naturalKey = naturalKeyFor({
      assetId: AssetId.of(assetId),
      institutionId: InstitutionId.of(institutionId),
      type: 'buy',
      tradeDate: BusinessDate.of(tradeDate),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString(unitPrice),
    });
    await migratorPool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, institution_id, type, status, trade_date, quantity,
          unit_price, fees, total_value, natural_key, occurrence)
       VALUES ($1, $2, $3, $4, 'buy', 'active', $5, $6, $7, '0', $8, $9, $10)`,
      [
        id,
        userId,
        assetId,
        institutionId,
        tradeDate,
        quantity,
        unitPrice,
        Money.fromString(unitPrice).times(Quantity.fromString(quantity)).toString(),
        naturalKey,
        occurrence,
      ],
    );
    return { id, naturalKey };
  };

  const addPosition = async (
    institutionId: string,
    quantity: string,
    averageCost: string,
  ): Promise<string> => {
    const id = randomUUID();
    await migratorPool.query(
      `INSERT INTO positions
         (id, user_id, asset_id, institution_id, quantity, average_cost, total_cost, realized_gain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '0')`,
      [
        id,
        userId,
        assetId,
        institutionId,
        quantity,
        averageCost,
        Money.fromString(averageCost).times(Quantity.fromString(quantity)).toString(),
      ],
    );
    return id;
  };

  const positionsNow = async () =>
    (
      await migratorPool.query(
        `SELECT institution_id, quantity::text AS quantity, average_cost::text AS average_cost
           FROM positions ORDER BY institution_id`,
      )
    ).rows as { institution_id: string; quantity: string; average_cost: string }[];

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 5 });
    appPool = new Pool({ connectionString: database.appUrl, max: 5 });
    appDb = drizzle(appPool, { schema });
  }, 180_000);

  afterAll(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await appPool.end();
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);
    assetId = randomUUID();
    await migratorPool.query(
      "INSERT INTO assets (id, code, name, class) VALUES ($1, 'WEGE3', 'WEG', 'stock')",
      [assetId],
    );
  });

  it('re-points the ledger of an abbreviated spelling onto its expansion, keys included', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    const kept = await addBuy(canonical, '2021-03-01', '5', '30');
    const moved = await addBuy(legacy, '2021-04-01', '5', '31');

    await migration();

    expect(await institutionsNow()).toEqual([{ id: canonical, name: INTER_FULL }]);
    const { rows } = await migratorPool.query(
      'SELECT id, institution_id, natural_key FROM transactions ORDER BY trade_date',
    );
    expect(rows.map((row) => row.institution_id)).toEqual([canonical, canonical]);
    expect(rows[0]?.natural_key).toBe(kept.naturalKey);
    expect(rows[1]?.natural_key).toBe(moved.naturalKey.replace(legacy, canonical));
  });

  it('re-points a position only one spelling held — that is exactly its replay', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    await addBuy(legacy, '2021-04-01', '10', '30');
    await addPosition(legacy, '10', '30');

    await migration();

    expect(await positionsNow()).toEqual([
      { institution_id: canonical, quantity: '10.00000000', average_cost: '30.00000000' },
    ]);
  });

  /**
   * The WEGE3 case. Neither cached figure survives a merge of two halves of
   * one holding, and no arithmetic in SQL reproduces the replay that does — so
   * the migration deletes both and `rebuild-positions` replays the ledger,
   * which is the authoritative side (BR-006-01, DM-4).
   */
  it('deletes both cached positions where the merge joins two halves of one asset, and a rebuild restores the merged figure', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    await addBuy(canonical, '2021-03-01', '10', '30');
    await addBuy(legacy, '2021-04-01', '10', '40');
    await addPosition(canonical, '10', '30');
    await addPosition(legacy, '10', '40');

    await migration();

    expect(await positionsNow()).toEqual([]);

    const outcome = await rebuildForTenant(userId, { dryRun: false }, appDb);
    expect(outcome.written).toBe(true);
    expect(await positionsNow()).toEqual([
      { institution_id: canonical, quantity: '20.00000000', average_cost: '35.00000000' },
    ]);
  });

  /**
   * XP is spelled three ways here. A pairwise merge would settle two of them
   * and then read the third as the only holder, leaving a cached row covering
   * a third of the ledger — a plausible figure with nothing to say it is
   * wrong, which is worse than the missing one a group-wide merge leaves.
   */
  it('deletes every cached position of a three-spelling group, and a rebuild restores the merged figure', async () => {
    const canonical = await addInstitution(XP_FULL);
    const cctvm = await addInstitution(XP_CCTVM);
    const truncated = await addInstitution(XP_TRUNCATED);
    await addBuy(canonical, '2021-03-01', '10', '30');
    await addBuy(cctvm, '2021-04-01', '10', '40');
    await addBuy(truncated, '2021-05-01', '10', '50');
    await addPosition(canonical, '10', '30');
    await addPosition(cctvm, '10', '40');
    await addPosition(truncated, '10', '50');

    await migration();

    expect(await positionsNow()).toEqual([]);

    await rebuildForTenant(userId, { dryRun: false }, appDb);
    expect(await positionsNow()).toEqual([
      { institution_id: canonical, quantity: '30.00000000', average_cost: '40.00000000' },
    ]);
  });

  /**
   * The cache is derived, so what it may keep is decided from the ledger. A
   * row whose own spelling holds none of the asset's transactions describes a
   * ledger that is not there, and re-pointing it would carry that forward.
   */
  it('deletes a cached position no transaction of its own spelling backs', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    await addBuy(canonical, '2021-03-01', '10', '30');
    await addPosition(legacy, '10', '30');

    await migration();

    expect(await positionsNow()).toEqual([]);
  });

  it('re-points staged rows and rewrites a stored reconciliation report', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    const batchId = randomUUID();
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status, reconciliation)
       VALUES ($1, $2, 'b3_movimentacao', 'committed', $3::jsonb)`,
      [
        batchId,
        userId,
        JSON.stringify({
          asOf: '2021-04-30',
          status: 'discrepancies_found',
          discrepancies: [{ assetId, institutionId: legacy, difference: '10' }],
        }),
      ],
    );
    const rowId = randomUUID();
    const { naturalKey } = {
      naturalKey: naturalKeyFor({
        assetId: AssetId.of(assetId),
        institutionId: InstitutionId.of(legacy),
        type: 'buy',
        tradeDate: BusinessDate.of('2021-04-01'),
        quantity: Quantity.fromString('10'),
        unitPrice: Money.fromString('30'),
      }),
    };
    await migratorPool.query(
      `INSERT INTO import_rows
         (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id,
          institution_id, natural_key, occurrence, ledger_type)
       VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, 'new', $5, $6, $7, 1, 'buy')`,
      [
        rowId,
        userId,
        batchId,
        JSON.stringify({ institutionName: INTER_SHORT }),
        assetId,
        legacy,
        naturalKey,
      ],
    );

    await migration();

    const { rows } = await migratorPool.query(
      'SELECT institution_id, natural_key, parsed_payload FROM import_rows WHERE id = $1',
      [rowId],
    );
    expect(rows[0]?.institution_id).toBe(canonical);
    expect(rows[0]?.natural_key).toBe(naturalKey.replace(legacy, canonical));
    // The extract said what it said: the staged record keeps B3's own spelling.
    expect(rows[0]?.parsed_payload).toEqual({ institutionName: INTER_SHORT });

    const { rows: batches } = await migratorPool.query(
      'SELECT reconciliation FROM import_batches WHERE id = $1',
      [batchId],
    );
    expect(JSON.stringify(batches[0]?.reconciliation)).not.toContain(legacy);
    expect(
      (batches[0]?.reconciliation as { discrepancies: { institutionId: string }[] })
        .discrepancies[0]?.institutionId,
    ).toBe(canonical);
  });

  it('aborts, writing nothing, when two rows would collide on one natural key', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    // The same date, quantity and price at both spellings: after the swap the
    // two keys are one, and nothing in the data says whether that is two
    // trades or one trade exported twice.
    await addBuy(canonical, '2021-04-01', '10', '30');
    await addBuy(legacy, '2021-04-01', '10', '30');
    const before = (
      await migratorPool.query(
        'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
      )
    ).rows;

    await expect(migration()).rejects.toThrow(/#136/);

    expect(
      (
        await migratorPool.query(
          'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
        )
      ).rows,
    ).toEqual(before);
    expect((await institutionsNow()).map((row) => row.name)).toEqual([INTER_FULL, INTER_SHORT]);
  });

  it('aborts on a clash between two legacy spellings, not only against the survivor', async () => {
    await addInstitution(XP_FULL);
    const cctvm = await addInstitution(XP_CCTVM);
    const truncated = await addInstitution(XP_TRUNCATED);
    await addBuy(cctvm, '2021-04-01', '10', '30');
    await addBuy(truncated, '2021-04-01', '10', '30');
    const before = (
      await migratorPool.query(
        'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
      )
    ).rows;

    await expect(migration()).rejects.toThrow(/#136/);

    expect(
      (
        await migratorPool.query(
          'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
        )
      ).rows,
    ).toEqual(before);
    expect(await institutionsNow()).toHaveLength(3);
  });

  it('keeps two brokers of one group apart, and an issuer apart from its custodian', async () => {
    await addInstitution(XP_FULL);
    await addInstitution(XP_CCTVM);
    await addInstitution(CLEAR);
    await addInstitution(BANCO_INTER);
    await addInstitution(INTER_SHORT);

    await migration();

    expect((await institutionsNow()).map((row) => row.name).sort()).toEqual(
      [BANCO_INTER, CLEAR, INTER_FULL, XP_FULL].sort(),
    );
  });

  it('merges spellings that differ only in punctuation, and renames the survivor B3 never spelled in full', async () => {
    const punctuated = await addInstitution('INTER DTVM, LTDA.');
    await addInstitution(INTER_SHORT);
    await addBuy(punctuated, '2021-04-01', '10', '30');

    await migration();

    const remaining = await institutionsNow();
    expect(remaining.map((row) => row.name)).toEqual([INTER_FULL]);
    const { rows } = await migratorPool.query('SELECT institution_id FROM transactions');
    expect(rows).toEqual([{ institution_id: remaining[0]?.id }]);
  });

  /**
   * `XP INVESTIMENTOS CCTVM S/A` sorts before the canonical spelling, so an
   * alphabetical survivor would be the abbreviation. The row the alias table
   * names wins, and only what has no such row falls back to the first by name.
   */
  it('keeps the row the alias table names, not the first by name', async () => {
    const cctvm = await addInstitution(XP_CCTVM);
    const canonical = await addInstitution(XP_FULL);
    const moved = await addBuy(cctvm, '2021-04-01', '10', '30');

    await migration();

    expect(await institutionsNow()).toEqual([{ id: canonical, name: XP_FULL }]);
    const { rows } = await migratorPool.query(
      'SELECT institution_id, natural_key FROM transactions',
    );
    expect(rows).toEqual([
      {
        institution_id: canonical,
        natural_key: moved.naturalKey.replace(cctvm, canonical),
      },
    ]);
  });

  /**
   * The same normalisation as `institution-identity.ts`: NFD, then drop what
   * is not printable ASCII. A hand-kept list of accented characters would be a
   * second rule for the two sides to disagree over, and a disagreement here is
   * a split that survives the migration silently.
   */
  it('merges a spelling accented the way B3 writes it', async () => {
    await addInstitution('INTER DISTRIBUIDORA DE TÍTULOS E VALORES MOBILIÁRIOS LTDA');
    await addInstitution(INTER_SHORT);

    await migration();

    expect((await institutionsNow()).map((row) => row.name)).toEqual([INTER_FULL]);
  });

  it('changes nothing on a second run', async () => {
    const canonical = await addInstitution(INTER_FULL);
    const legacy = await addInstitution(INTER_SHORT);
    await addBuy(canonical, '2021-03-01', '5', '30');
    await addBuy(legacy, '2021-04-01', '5', '31');

    await migration();
    const after = (
      await migratorPool.query(
        'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
      )
    ).rows;

    await migration();

    expect(
      (
        await migratorPool.query(
          'SELECT id, institution_id, natural_key FROM transactions ORDER BY id',
        )
      ).rows,
    ).toEqual(after);
    expect(await institutionsNow()).toEqual([{ id: canonical, name: INTER_FULL }]);
  });
});
