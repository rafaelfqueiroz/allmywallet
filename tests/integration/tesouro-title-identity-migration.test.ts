import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserId } from '@/core/shared/ids';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetLedger, resetUsers } from '../support/reset';
import { seedUser } from '../support/users';

/**
 * Migration `0029_tesouro_title_identity.sql` (#152).
 *
 * B3's extracts create a held Tesouro title as `Tesouro Selic 2029`;
 * `tesouro.sync` priced it under `Tesouro Selic 01/03/2029`, an asset nothing
 * held. These tests run the migration against a catalogue already holding
 * that split — the owner's four titles among them — which is the state that
 * matters. Titles and prices are invented (DV-24).
 */
describe('migration 0029 — Tesouro title identity (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const otherUserId = UserId.generate();

  const migration = async () =>
    migratorPool.query(
      await readFile(
        join(process.cwd(), 'src/db/migrations/0029_tesouro_title_identity.sql'),
        'utf8',
      ),
    );

  const addAsset = async (code: string, assetClass = 'tesouro_direto'): Promise<string> => {
    const id = randomUUID();
    await migratorPool.query('INSERT INTO assets (id, code, name, class) VALUES ($1, $2, $2, $3)', [
      id,
      code,
      assetClass,
    ]);
    return id;
  };

  const addClose = async (
    assetId: string,
    date: string,
    close: string,
    source = 'tesouro_transparente',
  ) =>
    migratorPool.query(
      'INSERT INTO price_quotes (asset_id, date, close, source) VALUES ($1, $2, $3, $4)',
      [assetId, date, close, source],
    );

  const addGap = async (assetId: string, date: string) =>
    migratorPool.query(
      "INSERT INTO price_quote_gaps (asset_id, date, reason) VALUES ($1, $2, 'not_supplied')",
      [assetId, date],
    );

  /** A buy of the held title, as the importer writes it. */
  const addBuy = async (assetId: string, owner: string = userId) =>
    migratorPool.query(
      `INSERT INTO transactions
         (id, user_id, asset_id, institution_id, type, status, trade_date, quantity,
          unit_price, fees, total_value, natural_key, occurrence)
       VALUES ($1, $2, $3, NULL, 'buy', 'active', '2025-01-10', '1', '10000', '0', '10000', $4, 1)`,
      [randomUUID(), owner, assetId, `2025-01-10|${assetId}||buy|1|10000`],
    );

  const assetsNow = async () =>
    (await migratorPool.query('SELECT id, code, name FROM assets ORDER BY code')).rows as {
      id: string;
      code: string;
      name: string;
    }[];

  const closesOf = async (assetId: string) =>
    (
      await migratorPool.query(
        "SELECT to_char(date, 'YYYY-MM-DD') AS date, close::text AS close, source FROM price_quotes WHERE asset_id = $1 ORDER BY date",
        [assetId],
      )
    ).rows as { date: string; close: string; source: string }[];

  const gapsOf = async (assetId: string) =>
    (
      await migratorPool.query(
        "SELECT to_char(date, 'YYYY-MM-DD') AS date FROM price_quote_gaps WHERE asset_id = $1 ORDER BY date",
        [assetId],
      )
    ).rows.map((row) => row.date as string);

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
    await seedUser(database.migrationUrl, otherUserId);
  });

  it('moves each priced series onto the held title B3 named, for the owner’s four titles', async () => {
    const pairs = [
      ['Tesouro Selic 2027', 'Tesouro Selic 01/03/2027'],
      ['Tesouro Selic 2029', 'Tesouro Selic 01/03/2029'],
      ['Tesouro Selic 2031', 'Tesouro Selic 01/03/2031'],
      ['Tesouro IPCA+ 2029', 'Tesouro IPCA+ 15/05/2029'],
    ] as const;
    const held: string[] = [];
    for (const [heldCode, pricedCode] of pairs) {
      const heldId = await addAsset(heldCode);
      await addBuy(heldId);
      const pricedId = await addAsset(pricedCode);
      await addClose(pricedId, '2026-09-18', '15000.10');
      await addClose(pricedId, '2026-09-21', '15010.20');
      held.push(heldId);
    }

    await migration();

    expect((await assetsNow()).map((row) => [row.id, row.code])).toEqual([
      [held[3], 'Tesouro IPCA+ 2029'],
      [held[0], 'Tesouro Selic 2027'],
      [held[1], 'Tesouro Selic 2029'],
      [held[2], 'Tesouro Selic 2031'],
    ]);
    for (const heldId of held) {
      expect(await closesOf(heldId)).toEqual([
        { date: '2026-09-18', close: '15000.10000000', source: 'tesouro_transparente' },
        { date: '2026-09-21', close: '15010.20000000', source: 'tesouro_transparente' },
      ]);
    }
  });

  it('renames a title nobody holds yet, keeping its id and its series', async () => {
    const pricedId = await addAsset('Tesouro Prefixado 01/01/2031');
    await addClose(pricedId, '2026-09-21', '700.55');

    await migration();

    expect(await assetsNow()).toEqual([
      { id: pricedId, code: 'Tesouro Prefixado 2031', name: 'Tesouro Prefixado 2031' },
    ]);
    expect(await closesOf(pricedId)).toHaveLength(1);
  });

  it('keeps a name the catalogue states rather than the code', async () => {
    const pricedId = await addAsset('Tesouro Selic 01/03/2029');
    await migratorPool.query("UPDATE assets SET name = 'Selic 29' WHERE id = $1", [pricedId]);

    await migration();

    expect(await assetsNow()).toEqual([
      { id: pricedId, code: 'Tesouro Selic 2029', name: 'Selic 29' },
    ]);
  });

  /**
   * Named for the year payments start, not the maturity: reading the year of
   * `15/12/2030` would name this the 2030 Educa+, which is a different title.
   */
  it('leaves Educa+, Renda+ and a date-shaped code of another class alone', async () => {
    await addAsset('Tesouro Educa+ 15/12/2030');
    await addAsset('Tesouro Renda+ Aposentadoria Extra 15/12/2049');
    await addAsset('Tesouro Selic 01/03/2029', 'stock');

    await migration();

    expect((await assetsNow()).map((row) => row.code)).toEqual([
      'Tesouro Educa+ 15/12/2030',
      'Tesouro Renda+ Aposentadoria Extra 15/12/2049',
      'Tesouro Selic 01/03/2029',
    ]);
  });

  it('leaves both titles alone where two maturities would share one B3 code', async () => {
    const heldId = await addAsset('Tesouro Prefixado 2010');
    await addAsset('Tesouro Prefixado 01/01/2010');
    await addAsset('Tesouro Prefixado 01/07/2010');

    await migration();

    expect((await assetsNow()).map((row) => row.code)).toEqual([
      'Tesouro Prefixado 01/01/2010',
      'Tesouro Prefixado 01/07/2010',
      'Tesouro Prefixado 2010',
    ]);
    expect(await closesOf(heldId)).toEqual([]);
  });

  it('Tesouro Transparente’s close wins a date both carry, and a recovered gap is deleted', async () => {
    const heldId = await addAsset('Tesouro Selic 2029');
    const pricedId = await addAsset('Tesouro Selic 01/03/2029');
    await addClose(heldId, '2026-09-18', '1.00', 'other');
    await addClose(heldId, '2026-09-17', '2.00', 'other');
    await addClose(pricedId, '2026-09-18', '15000.10');
    await addGap(heldId, '2026-09-21');
    await addGap(heldId, '2026-09-22');
    await addClose(pricedId, '2026-09-21', '15010.20');
    await addGap(pricedId, '2026-09-22');
    await addGap(pricedId, '2026-09-23');

    await migration();

    expect(await closesOf(heldId)).toEqual([
      { date: '2026-09-17', close: '2.00000000', source: 'other' },
      { date: '2026-09-18', close: '15000.10000000', source: 'tesouro_transparente' },
      { date: '2026-09-21', close: '15010.20000000', source: 'tesouro_transparente' },
    ]);
    expect(await gapsOf(heldId)).toEqual(['2026-09-22', '2026-09-23']);
    expect((await assetsNow()).map((row) => row.code)).toEqual(['Tesouro Selic 2029']);
  });

  it('moves an intraday quote only where the held title has none', async () => {
    const heldId = await addAsset('Tesouro Selic 2029');
    const pricedId = await addAsset('Tesouro Selic 01/03/2029');
    await migratorPool.query(
      `INSERT INTO latest_quotes (asset_id, price, quoted_at, fetched_at, source)
       VALUES ($1, '15000', now(), now(), 'x')`,
      [pricedId],
    );

    await migration();

    const { rows } = await migratorPool.query('SELECT asset_id FROM latest_quotes');
    expect(rows).toEqual([{ asset_id: heldId }]);
  });

  /**
   * A full-date asset some tenant row names is a split between two ledgers,
   * not a market-data duplicate. Joining it by this rule would put two sets of
   * transactions under one position unreviewed.
   */
  it('aborts, writing nothing, when a tenant row names the full-date asset', async () => {
    const heldId = await addAsset('Tesouro Selic 2029');
    const pricedId = await addAsset('Tesouro Selic 01/03/2029');
    await addClose(pricedId, '2026-09-21', '15010.20');
    const renamedId = await addAsset('Tesouro Prefixado 01/01/2031');
    await addBuy(heldId);
    await addBuy(pricedId, otherUserId);

    await expect(migration()).rejects.toThrow(/#152/);

    expect((await assetsNow()).map((row) => [row.id, row.code])).toEqual([
      [renamedId, 'Tesouro Prefixado 01/01/2031'],
      [pricedId, 'Tesouro Selic 01/03/2029'],
      [heldId, 'Tesouro Selic 2029'],
    ]);
    expect(await closesOf(pricedId)).toHaveLength(1);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    const heldId = await addAsset('Tesouro IPCA+ 2029');
    const pricedId = await addAsset('Tesouro IPCA+ 15/05/2029');
    await addClose(pricedId, '2026-09-21', '4100.00');
    await addAsset('Tesouro Selic 01/03/2031');

    await migration();
    const assets = await assetsNow();
    const closes = await closesOf(heldId);
    await migration();

    expect(await assetsNow()).toEqual(assets);
    expect(await closesOf(heldId)).toEqual(closes);
  });
});
