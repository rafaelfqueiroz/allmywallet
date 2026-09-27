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
 * Migration `0030_tesouro_educa_renda_identity.sql` (#164).
 *
 * Educa+ and Renda+ are named for the year payments start, so 0029 left them
 * under Tesouro Transparente's full date (`Tesouro Educa+ 15/12/2030`), where
 * a holding imported as `Tesouro Educa+ 2026` would never meet its price.
 * Titles and prices are invented (DV-24).
 */
describe('migration 0030 — Tesouro Educa+ and Renda+ identity (integration)', () => {
  let database: TestDatabase;
  let migratorPool: Pool;

  const userId = UserId.generate();
  const otherUserId = UserId.generate();

  const migration = async () =>
    migratorPool.query(
      await readFile(
        join(process.cwd(), 'src/db/migrations/0030_tesouro_educa_renda_identity.sql'),
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

  it('renames each full-date Educa+ and Renda+ to the year its payments start, history kept', async () => {
    const educa = await addAsset('Tesouro Educa+ 15/12/2030');
    const renda = await addAsset('Tesouro Renda+ Aposentadoria Extra 15/12/2049');
    await addClose(educa, '2026-09-21', '3200.10');
    await addClose(renda, '2026-09-21', '1500.20');

    await migration();

    expect(await assetsNow()).toEqual([
      { id: educa, code: 'Tesouro Educa+ 2026', name: 'Tesouro Educa+ 2026' },
      {
        id: renda,
        code: 'Tesouro Renda+ Aposentadoria Extra 2030',
        name: 'Tesouro Renda+ Aposentadoria Extra 2030',
      },
    ]);
    expect(await closesOf(educa)).toHaveLength(1);
    expect(await closesOf(renda)).toHaveLength(1);
  });

  it('moves the series onto a held B3-named title and deletes the full-date asset', async () => {
    const held = await addAsset('Tesouro Renda+ Aposentadoria Extra 2030');
    await addBuy(held);
    const priced = await addAsset('Tesouro Renda+ Aposentadoria Extra 15/12/2049');
    await addClose(priced, '2026-09-21', '1500.20');
    await addGap(held, '2026-09-21');

    await migration();

    expect((await assetsNow()).map((row) => [row.id, row.code])).toEqual([
      [held, 'Tesouro Renda+ Aposentadoria Extra 2030'],
    ]);
    expect(await closesOf(held)).toEqual([
      { date: '2026-09-21', close: '1500.20000000', source: 'tesouro_transparente' },
    ]);
    expect(await gapsOf(held)).toEqual([]);
  });

  it('leaves a maturity off the product’s 15 December alone, and every other product', async () => {
    await addAsset('Tesouro Educa+ 15/06/2030');
    await addAsset('Tesouro Selic 2029');
    await addAsset('Tesouro Novo 15/12/2030');

    await migration();

    expect((await assetsNow()).map((row) => row.code)).toEqual([
      'Tesouro Educa+ 15/06/2030',
      'Tesouro Novo 15/12/2030',
      'Tesouro Selic 2029',
    ]);
  });

  it('aborts, writing nothing, when a tenant row names the full-date asset', async () => {
    const held = await addAsset('Tesouro Educa+ 2026');
    const priced = await addAsset('Tesouro Educa+ 15/12/2030');
    const renamed = await addAsset('Tesouro Renda+ Aposentadoria Extra 15/12/2049');
    await addBuy(held);
    await addBuy(priced, otherUserId);

    await expect(migration()).rejects.toThrow(/#164/);

    expect((await assetsNow()).map((row) => [row.id, row.code])).toEqual([
      [priced, 'Tesouro Educa+ 15/12/2030'],
      [held, 'Tesouro Educa+ 2026'],
      [renamed, 'Tesouro Renda+ Aposentadoria Extra 15/12/2049'],
    ]);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    await addAsset('Tesouro Educa+ 15/12/2030');
    const held = await addAsset('Tesouro Renda+ Aposentadoria Extra 2030');
    const priced = await addAsset('Tesouro Renda+ Aposentadoria Extra 15/12/2049');
    await addClose(priced, '2026-09-21', '1500.20');

    await migration();
    const assets = await assetsNow();
    const closes = await closesOf(held);
    await migration();

    expect(await assetsNow()).toEqual(assets);
    expect(await closesOf(held)).toEqual(closes);
  });
});
