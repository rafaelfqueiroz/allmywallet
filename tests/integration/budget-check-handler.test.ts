import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@/db/schema';
import { FakeClock } from '@/core/shared/clock';
import type { AssetId } from '@/core/shared/ids';
import { getEffectiveConfig } from '@/config/effective';
import { setConfigValue, invalidateDeploymentCache } from '@/config/resolve';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteBudgetCounter } from '@/adapters/db/quote-budget-counter';
import { FakeHeldAssetsPort, FakeTradingCalendar } from '@/core/quotes/test-support';
import { handleBudgetCheck } from '@/worker/handlers/budget';
import { applyMigrations, startTestDatabase, type TestDatabase } from '../support/postgres';
import { resetConfigState } from '../support/reset';

/**
 * SPEC-008 BR-008-21/22/23 — the automatic-degradation loop, end to end
 * against real Postgres: `budget.check` writes `runtime_state`, and
 * `getEffectiveConfig` (SPEC-002's own operator-facing view) is what proves
 * an operator can tell the result apart from something they configured
 * themselves, and that it survives a simulated redeploy (a fresh read with
 * the deployment cache invalidated, exactly as a new process would see it).
 */
describe('SPEC-008 budget.check handler — cadence degradation (integration)', () => {
  let database: TestDatabase;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    database = await startTestDatabase();
    await applyMigrations(database.migrationUrl);
    pool = new Pool({ connectionString: database.appUrl, max: 1 });
    db = drizzle(pool, { schema });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  beforeEach(async () => {
    await resetConfigState(database.migrationUrl);
    const migratorPool = new Pool({ connectionString: database.migrationUrl, max: 1 });
    try {
      await migratorPool.query('TRUNCATE quote_budget_usage, assets RESTART IDENTITY CASCADE');
    } finally {
      await migratorPool.end();
    }
    invalidateDeploymentCache();
  });

  /** All March 2026 weekdays — 22 of them, close enough to the spec's "~21 trading days" reference to reproduce its ladder math. */
  function marchWeekdays(): string[] {
    const days: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      const date = new Date(Date.UTC(2026, 2, day));
      const weekday = date.getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        days.push(`2026-03-${String(day).padStart(2, '0')}`);
      }
    }
    return days;
  }

  async function seedHeldAssets(count: number): Promise<AssetId[]> {
    const catalog = new DrizzleAssetCatalogRepository(db);
    const ids: AssetId[] = [];
    for (let i = 0; i < count; i += 1) {
      const asset = await catalog.upsertByCode({
        code: `STOCK${i}`,
        name: `Stock ${i}`,
        assetClass: 'stock',
      });
      ids.push(asset.id);
    }
    return ids;
  }

  it('degrades the cadence automatically once the held universe outgrows the operator setting, distinguishably from an operator change', async () => {
    // 200 distinct held assets outgrows every rung of the default ladder
    // (30/60/120 -> ~42/~80/~160 assets, per the spec's own reference table).
    const heldIds = await seedHeldAssets(200);
    const heldAssets = new FakeHeldAssetsPort(heldIds);
    const calendar = new FakeTradingCalendar(marchWeekdays());
    const catalog = new DrizzleAssetCatalogRepository(db);
    const budgetCounter = new DrizzleQuoteBudgetCounter(db);

    await handleBudgetCheck({
      database: db,
      clock: new FakeClock('2026-03-16T14:00:00Z'),
      calendar,
      catalog,
      budgetCounter,
      heldAssets,
    });

    // BR-008-23: a fresh read, cache invalidated — simulates a new process
    // (a redeploy) reading configuration from scratch.
    invalidateDeploymentCache();
    const effective = await getEffectiveConfig(db);
    const cadence = effective.find((e) => e.key === 'quotes.cadence_minutes');
    expect(cadence?.value).toBe(120); // the most conservative rung
    expect(cadence?.source).toBe('runtime');
    expect(cadence?.reason).toMatch(/BR-008-22/);

    // The operator's own registry default is untouched — this is what makes
    // the degradation distinguishable from something an operator configured:
    // no config_overrides row exists for this key at all.
    const operatorRows = await pool.query(
      `SELECT 1 FROM config_overrides WHERE key = 'quotes.cadence_minutes' AND level = 'deployment'`,
    );
    expect(operatorRows.rowCount).toBe(0);
  });

  it('an operator-set cadence looks different from a system-degraded one in the same view', async () => {
    await setConfigValue(db, {
      key: 'quotes.cadence_minutes',
      level: 'deployment',
      value: 45,
      actor: { kind: 'operator' },
    });
    invalidateDeploymentCache();

    const effective = await getEffectiveConfig(db);
    const cadence = effective.find((e) => e.key === 'quotes.cadence_minutes');
    expect(cadence?.value).toBe(45);
    expect(cadence?.source).toBe('deployment'); // not 'runtime' — an operator's own choice
    expect(cadence?.reason).toBeUndefined();
  });

  it('clears a stale degradation once usage falls back within the operator’s own cadence', async () => {
    const heldIds = await seedHeldAssets(200);
    const heldAssets = new FakeHeldAssetsPort(heldIds);
    const calendar = new FakeTradingCalendar(marchWeekdays());
    const catalog = new DrizzleAssetCatalogRepository(db);
    const budgetCounter = new DrizzleQuoteBudgetCounter(db);
    const deps = { database: db, calendar, catalog, budgetCounter, heldAssets };

    await handleBudgetCheck({ ...deps, clock: new FakeClock('2026-03-16T14:00:00Z') });
    invalidateDeploymentCache();
    let effective = await getEffectiveConfig(db);
    expect(effective.find((e) => e.key === 'quotes.cadence_minutes')?.source).toBe('runtime');

    // The universe shrinks back to nothing.
    heldAssets.set([]);
    await handleBudgetCheck({ ...deps, clock: new FakeClock('2026-03-16T14:05:00Z') });
    invalidateDeploymentCache();
    effective = await getEffectiveConfig(db);
    expect(effective.find((e) => e.key === 'quotes.cadence_minutes')?.source).toBe('default');
  });
});
