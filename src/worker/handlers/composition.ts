import { eq, and } from 'drizzle-orm';
import { db as globalDb, type Database } from '@/db/client';
import { SystemClock } from '@/core/shared/clock';
import { resolveConfig } from '@/config/resolve';
import { registryEntry } from '@/config/registry';
import { configOverrides } from '@/db/schema/config';
import { DrizzleAssetCatalogRepository } from '@/adapters/db/asset-catalog-repository';
import { DrizzleQuoteRepository } from '@/adapters/db/quote-repository';
import { DrizzleIndexSeriesRepository } from '@/adapters/db/index-series-repository';
import { DrizzleQuoteBudgetCounter } from '@/adapters/db/quote-budget-counter';
import { B3TradingCalendar } from '@/adapters/calendar/b3-calendar';
import { BrapiQuoteProvider } from '@/adapters/quotes/brapi';
import { BcbSgsIndexSeriesProvider } from '@/adapters/quotes/bcb-sgs';
import { TesouroTransparenteProvider } from '@/adapters/quotes/tesouro';

/**
 * AR-04: worker handlers are thin entrypoints — this is the composition
 * root that wires `core/quotes/`'s ports to their concrete adapters for the
 * scheduled jobs in this directory. Quote-polling jobs run with **no tenant
 * context** (SPEC-003 BR-003-07 — the only cross-tenant work permitted,
 * since every table touched here is a shared reference table), so this
 * reads a `Database` directly rather than through `withTenant`.
 *
 * Every function here takes an optional `database` parameter, defaulting to
 * the process-wide singleton (`@/db/client`) — this is what lets an
 * integration test point config resolution at its own Testcontainers
 * instance instead of the real `DATABASE_URL`. Without it, `resolveConfig`
 * calls buried inside a handler would silently reconnect to whatever
 * `env().DATABASE_URL` happens to be (a placeholder in the test environment)
 * even when every port passed to the handler was correctly overridden.
 */
export function buildQuotesComposition(database: Database = globalDb) {
  const clock = new SystemClock();
  const calendar = new B3TradingCalendar();
  const catalog = new DrizzleAssetCatalogRepository(database);
  const repository = new DrizzleQuoteRepository(database);
  const indexSeriesRepository = new DrizzleIndexSeriesRepository(database);
  const budgetCounter = new DrizzleQuoteBudgetCounter(database);
  return { clock, calendar, catalog, repository, indexSeriesRepository, budgetCounter };
}

/** BR-008-26: the provider is resolved from config, never hardcoded — swapping vendor/tier is a config change. */
export async function buildQuoteProvider(
  database: Database = globalDb,
): Promise<BrapiQuoteProvider> {
  const provider = await resolveConfig('quotes.provider', { db: database });
  return new BrapiQuoteProvider({ source: provider.value });
}

export function buildIndexSeriesProvider(): BcbSgsIndexSeriesProvider {
  return new BcbSgsIndexSeriesProvider({ source: 'bcb_sgs' });
}

export function buildTesouroProvider(): TesouroTransparenteProvider {
  return new TesouroTransparenteProvider({ source: 'tesouro_transparente' });
}

export interface QuoteBudgetConfig {
  readonly cadenceMinutes: number;
  readonly monthlyQuota: number;
  readonly ondemandReservePct: number;
  readonly budgetAlertPct: number;
  readonly degradationLadder: readonly number[];
}

/** Deployment-level resolution — no `userId`, so runtime-state (BR-008-22) wins over the operator default when one exists. */
export async function resolveQuoteBudgetConfig(
  database: Database = globalDb,
): Promise<QuoteBudgetConfig> {
  const [cadence, quota, reservePct, alertPct, ladder] = await Promise.all([
    resolveConfig('quotes.cadence_minutes', { db: database }),
    resolveConfig('quotes.monthly_quota', { db: database }),
    resolveConfig('quotes.ondemand_reserve_pct', { db: database }),
    resolveConfig('quotes.budget_alert_pct', { db: database }),
    resolveConfig('quotes.degradation_ladder', { db: database }),
  ]);
  return {
    cadenceMinutes: cadence.value,
    monthlyQuota: quota.value,
    ondemandReservePct: reservePct.value,
    budgetAlertPct: alertPct.value,
    degradationLadder: ladder.value,
  };
}

/**
 * BR-008-22/23: the operator's own `quotes.cadence_minutes` setting,
 * deliberately bypassing `runtime_state` — `resolveConfig` cannot answer
 * this (it prefers runtime by design, per BR-008-22's whole point), so
 * `budget.check` reads the deployment layer directly to decide whether a
 * degradation is still warranted or should be cleared.
 */
export async function resolveOperatorCadenceMinutes(
  database: Database = globalDb,
): Promise<number> {
  const [row] = await database
    .select({ value: configOverrides.value })
    .from(configOverrides)
    .where(
      and(
        eq(configOverrides.key, 'quotes.cadence_minutes'),
        eq(configOverrides.level, 'deployment'),
      ),
    );
  const entry = registryEntry('quotes.cadence_minutes');
  if (row) {
    const parsed = entry.schema.safeParse(row.value);
    if (parsed.success) return parsed.data;
  }
  return entry.default;
}
