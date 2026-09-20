import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssetId, InstitutionId, UserId } from '@/core/shared/ids';
import { BusinessDate } from '@/core/shared/clock';
import { Money, Quantity } from '@/core/shared/money';
import { naturalKeyFor } from '@/core/ledger/natural-key';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0025_merge_asset_code_aliases.sql` (#135).
 *
 * B3 settled the July 2023 Energias do Brasil buyout on `ENBR3L`, its auction
 * ticker, and printed the disposal under it — while Movimentação coded both
 * custody legs of the same event `ENBR3`. A position is keyed by `(asset,
 * institution)` (SPEC-007 BR-007-08), so the ledger held `ENBR3L` as an asset
 * of its own with no position behind it. These tests run the migration against
 * a database already holding that split, which is the state that matters.
 */
describe('migration 0025 — asset code aliases (integration)', () => {
  const LEGACY = 'ENBR3L';
  const CANONICAL = 'ENBR3';

  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  let institutionId: string;

  const migration = async () =>
    migratorPool.query(
      await readFile(
        join(process.cwd(), 'src/db/migrations/0025_merge_asset_code_aliases.sql'),
        'utf8',
      ),
    );

  const addAsset = async (code: string, name: string): Promise<string> => {
    const id = randomUUID();
    await migratorPool.query(
      "INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $3, 'stock')",
      [id, code, name],
    );
    return id;
  };

  const addSell = async (
    assetId: string,
    tradeDate: string,
    quantity: string,
    unitPrice: string,
  ): Promise<{ id: string; naturalKey: string }> => {
    const id = randomUUID();
    const naturalKey = naturalKeyFor({
      assetId: AssetId.of(assetId),
      institutionId: InstitutionId.of(institutionId),
      type: 'sell',
      tradeDate: BusinessDate.of(tradeDate),
      quantity: Quantity.fromString(quantity),
      unitPrice: Money.fromString(unitPrice),
    });
    await migratorPool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, institution_id, type, status, trade_date, quantity,
          unit_price, fees, total_value, natural_key, occurrence)
       VALUES ($1, $2, $3, $4, 'sell', 'active', $5, $6, $7, '0', $8, $9, 1)`,
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
      ],
    );
    return { id, naturalKey };
  };

  /** The owner's real shape: a refused Negociação row, stored `invalid`. */
  const addRefusedRow = async (assetId: string, code: string): Promise<string> => {
    const id = randomUUID();
    const batchId = randomUUID();
    await migratorPool.query(
      `INSERT INTO import_batches (id, user_id, source, status) VALUES ($1, $2, 'b3_negociacao', 'committed')`,
      [batchId, userId],
    );
    await migratorPool.query(
      `INSERT INTO import_rows
         (id, user_id, batch_id, raw_payload, parsed_payload, classification, asset_id,
          institution_id, natural_key, occurrence, ledger_type)
       VALUES ($1, $2, $3, $4, $5, 'invalid', $6, $7, $8, 1, 'sell')`,
      [
        id,
        userId,
        batchId,
        JSON.stringify({ 'Código de Negociação': code }),
        JSON.stringify({ kind: 'transaction', assetCode: code, assetName: code }),
        assetId,
        institutionId,
        `2023-07-11|${assetId}|${institutionId}|sell|101|23.73`,
      ],
    );
    return id;
  };

  const assetsNow = async () =>
    (await migratorPool.query('SELECT code, name FROM assets ORDER BY code')).rows as {
      code: string;
      name: string;
    }[];

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    migratorPool = new Pool({ connectionString: database.migrationUrl, max: 5 });
  }, 180_000);

  afterAll(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await migratorPool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetLedger(database.migrationUrl);
    await resetUsers(database.migrationUrl);
    await seedUser(database.migrationUrl, userId);
    institutionId = randomUUID();
    await migratorPool.query("INSERT INTO institutions (id, name) VALUES ($1, 'CLEAR')", [
      institutionId,
    ]);
  });

  it('re-points the ledger of the auction ticker onto the listed asset, keys included', async () => {
    const canonical = await addAsset(CANONICAL, 'EDP ENERGIAS DO BRASIL S.A.');
    const legacy = await addAsset(LEGACY, LEGACY);
    const moved = await addSell(legacy, '2023-07-11', '101', '23.73');

    await migration();

    expect(await assetsNow()).toEqual([{ code: CANONICAL, name: 'EDP ENERGIAS DO BRASIL S.A.' }]);
    const { rows } = await migratorPool.query(
      'SELECT asset_id, natural_key FROM transactions WHERE id = $1',
      [moved.id],
    );
    expect(rows[0]?.asset_id).toBe(canonical);
    expect(rows[0]?.natural_key).toBe(moved.naturalKey.replace(legacy, canonical));
  });

  /**
   * The owner's own state: the sales never reached the ledger, so all that
   * names the legacy asset is a refused row in a committed batch. The refusal
   * screen rebuilds a candidate from `parsed_payload`, so one still naming the
   * deleted asset would read against a ledger that is not there.
   */
  it('re-points a refused import row and the code its parsed payload names', async () => {
    const canonical = await addAsset(CANONICAL, 'EDP ENERGIAS DO BRASIL S.A.');
    const legacy = await addAsset(LEGACY, LEGACY);
    const rowId = await addRefusedRow(legacy, LEGACY);

    await migration();

    const { rows } = await migratorPool.query(
      'SELECT asset_id, natural_key, parsed_payload FROM import_rows WHERE id = $1',
      [rowId],
    );
    expect(rows[0]?.asset_id).toBe(canonical);
    expect(rows[0]?.natural_key).toContain(canonical);
    expect(rows[0]?.natural_key).not.toContain(legacy);
    expect(rows[0]?.parsed_payload).toMatchObject({
      assetCode: CANONICAL,
      assetName: CANONICAL,
    });
  });

  it('renames the asset where no canonical one exists yet, moving nothing', async () => {
    const legacy = await addAsset(LEGACY, LEGACY);
    const sale = await addSell(legacy, '2023-07-11', '101', '23.73');

    await migration();

    expect(await assetsNow()).toEqual([{ code: CANONICAL, name: CANONICAL }]);
    const { rows } = await migratorPool.query(
      'SELECT asset_id, natural_key FROM transactions WHERE id = $1',
      [sale.id],
    );
    expect(rows[0]?.asset_id).toBe(legacy);
    expect(rows[0]?.natural_key).toBe(sale.naturalKey);
  });

  it('leaves every other asset alone — no suffix rule is inferred', async () => {
    await addAsset('ALOS3', 'Allos');
    await addAsset('KLBN11', 'Klabin');

    await migration();

    expect((await assetsNow()).map((row) => row.code)).toEqual(['ALOS3', 'KLBN11']);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    await addAsset(CANONICAL, 'EDP ENERGIAS DO BRASIL S.A.');
    const legacy = await addAsset(LEGACY, LEGACY);
    await addSell(legacy, '2023-07-11', '101', '23.73');

    await migration();
    const after = (
      await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id')
    ).rows;
    await migration();

    expect(
      (await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id'))
        .rows,
    ).toEqual(after);
    expect(await assetsNow()).toEqual([{ code: CANONICAL, name: 'EDP ENERGIAS DO BRASIL S.A.' }]);
  });

  /**
   * Two rows that collide after the swap are the same date, institution, type,
   * quantity and price on what is now one asset. Nothing in the data tells a
   * genuine repeat from one export of it under two codes, and renumbering the
   * second would silently double a holding.
   */
  it('aborts, writing nothing, when a natural key would clash', async () => {
    const canonical = await addAsset(CANONICAL, 'EDP ENERGIAS DO BRASIL S.A.');
    const legacy = await addAsset(LEGACY, LEGACY);
    await addSell(canonical, '2023-07-11', '101', '23.73');
    await addSell(legacy, '2023-07-11', '101', '23.73');
    const before = (
      await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id')
    ).rows;

    await expect(migration()).rejects.toThrow(/#135/);

    expect(
      (await migratorPool.query('SELECT id, asset_id, natural_key FROM transactions ORDER BY id'))
        .rows,
    ).toEqual(before);
    expect((await assetsNow()).map((row) => row.code)).toEqual([CANONICAL, LEGACY]);
  });
});
