import { z } from 'zod';

/**
 * SPEC-002 — the single validated registry. BR-002-01: introducing a new
 * tunable means adding an entry here, never a literal anywhere else in the
 * application. AR-40: every key carries a Zod schema, a default and the
 * levels permitted to set it, checked at process start.
 *
 * This file is deliberately framework-free (only `zod`), so it can be
 * imported from a unit test, `core/`-adjacent code, or the web/worker
 * entrypoints without pulling in Drizzle or Next — nothing here reads the
 * database or the environment.
 */

/**
 * BR-002-02: resolution order is default → deployment → tenant → user, most
 * specific wins. `tenant` exists as a level for keys that outgrow a single
 * user in the future (DL-002-06); no key in the v1 registry below declares it,
 * which is expected, not a bug.
 */
export const CONFIG_LEVELS = ['deployment', 'tenant', 'user'] as const;
export type ConfigLevel = (typeof CONFIG_LEVELS)[number];

export interface RegistryEntryDef<T = unknown> {
  /** Duplicated from the object key so callers iterating `Object.values` never lose it. */
  readonly key: string;
  readonly schema: z.ZodType<T>;
  readonly default: T;
  /** Levels permitted to set this key (BR-002-03). Read level is always all four. */
  readonly levels: readonly ConfigLevel[];
  readonly description: string;
  /**
   * Human-readable permitted range, used in the boot-failure message
   * (BR-002-04 requires the key, the offending value *and* the permitted
   * range) and in the operator-facing effective-config view.
   */
  readonly range: string;
}

/**
 * SPEC-002 initial registry — one entry per row of the spec's "Initial
 * registry" table. Kept as a single `satisfies`-checked object literal so
 * each key's schema/default types round-trip through `ConfigValue<K>` below
 * without a hand-written union.
 */
export const REGISTRY = {
  'quotes.cadence_minutes': {
    key: 'quotes.cadence_minutes',
    // BR-002-04 / DL-002-01: `0` must fail, never be read as "poll continuously".
    schema: z.number().int().min(1).max(1440),
    default: 30,
    levels: ['deployment'],
    description: 'Minutes between quote polls during market hours.',
    range: 'integer, 1–1440',
  },
  'quotes.degradation_ladder': {
    key: 'quotes.degradation_ladder',
    schema: z
      .array(z.number().int().min(1).max(1440))
      .min(1)
      .refine((ladder) => ladder.every((v, i) => i === 0 || v > (ladder[i - 1] ?? 0)), {
        message: 'must be strictly ascending',
      }),
    default: [30, 60, 120],
    levels: ['deployment'],
    description:
      'SPEC-008 BR-008-22: cadence steps (minutes) the poller degrades through under budget pressure.',
    range: 'ascending integer array, each 1–1440',
  },
  'quotes.ondemand_reserve_pct': {
    key: 'quotes.ondemand_reserve_pct',
    schema: z.number().int().min(0).max(100),
    default: 10,
    levels: ['deployment'],
    description: 'Percent of the monthly quote quota reserved for on-demand requests (FR-6.21).',
    range: 'integer percent, 0–100',
  },
  'quotes.monthly_quota': {
    key: 'quotes.monthly_quota',
    schema: z.number().int().min(1),
    default: 15000,
    levels: ['deployment'],
    description: 'Provider request budget per calendar month (F6.1).',
    range: 'positive integer',
  },
  'quotes.budget_alert_pct': {
    key: 'quotes.budget_alert_pct',
    schema: z.number().int().min(1).max(100),
    default: 70,
    levels: ['deployment'],
    description: 'Percent of the monthly quota that raises a budget alert (FR-6.13).',
    range: 'integer percent, 1–100',
  },
  'quotes.provider': {
    key: 'quotes.provider',
    // AR-03: QuoteProvider is a real port with a swappable implementation, but
    // v1 ships exactly one. Extend this enum, never widen it to a bare string.
    schema: z.enum(['brapi_free']),
    default: 'brapi_free',
    levels: ['deployment'],
    description: 'Which QuoteProvider adapter is active (FR-6.10).',
    range: "one of: 'brapi_free'",
  },
  'quotes.ondemand_rate_limit': {
    key: 'quotes.ondemand_rate_limit',
    // The spec table lists this default as "—" — unset. `null` means
    // unbounded rather than inventing a number the spec never gave.
    schema: z.number().int().min(1).nullable(),
    default: null,
    levels: ['deployment'],
    description:
      'Max on-demand quote requests per user per minute; null means unbounded (FR-6.22).',
    range: 'positive integer, or null for unbounded',
  },
  'market.trading_calendar': {
    key: 'market.trading_calendar',
    // The calendar *data* (B3 holidays) is out of this spec's scope — this key
    // only selects which named calendar the TradingCalendar port loads.
    schema: z.enum(['B3']),
    default: 'B3',
    levels: ['deployment'],
    description: 'Which trading calendar dataset the TradingCalendar port uses (FR-6.6).',
    range: "one of: 'B3'",
  },
  'import.staleness_days': {
    key: 'import.staleness_days',
    schema: z.number().int().min(1).max(365),
    default: 30,
    levels: ['deployment', 'user'],
    description: 'Days since last import before a staleness reminder is due (FR-4.2).',
    range: 'integer, 1–365',
  },
  'import.reminder_enabled': {
    key: 'import.reminder_enabled',
    schema: z.boolean(),
    default: false,
    levels: ['user'],
    description: 'Opt-in staleness reminder emails (FR-4.3).',
    range: 'boolean',
  },
  'import.max_upload_mb': {
    key: 'import.max_upload_mb',
    schema: z.number().int().min(1).max(100),
    default: 10,
    levels: ['deployment'],
    description: 'Maximum accepted extract size in megabytes (FR-2.4).',
    range: 'integer, 1–100',
  },
  'reports.concentration_threshold_pct': {
    key: 'reports.concentration_threshold_pct',
    schema: z.number().int().min(1).max(100),
    default: 20,
    levels: ['user'],
    description: 'Position weight that triggers a concentration flag (FR-5.24).',
    range: 'integer percent, 1–100',
  },
  /**
   * SPEC-011 BR-011-04: "asset class is the default grouping at portfolio
   * scope; individual asset is the default within a single-wallet scope. Both
   * are user-configurable." Two scopes, two defaults, therefore two keys — one
   * key could not express the second half of the rule.
   */
  'reports.default_grouping': {
    key: 'reports.default_grouping',
    // 'sector' is one of BR-011-03's five dimensions and was missing here,
    // which made it the one grouping a user could select but never default to.
    schema: z.enum(['asset_class', 'wallet', 'asset', 'sector', 'institution']),
    default: 'asset_class',
    levels: ['user'],
    description: 'Default grouping dimension at portfolio scope (FR-5.28, SPEC-011 BR-011-04).',
    range: "one of: 'asset_class', 'wallet', 'asset', 'sector', 'institution'",
  },
  'reports.default_grouping_wallet_scope': {
    key: 'reports.default_grouping_wallet_scope',
    schema: z.enum(['asset_class', 'wallet', 'asset', 'sector', 'institution']),
    // Inside one wallet the user has already answered "what am I exposed to"
    // by choosing the wallet, so the useful first question becomes "what is
    // actually in here" — which is asset-level.
    default: 'asset',
    levels: ['user'],
    description: 'Default grouping dimension within a single-wallet scope (SPEC-011 BR-011-04).',
    range: "one of: 'asset_class', 'wallet', 'asset', 'sector', 'institution'",
  },
  'reports.benchmarks': {
    key: 'reports.benchmarks',
    schema: z.array(z.enum(['CDI', 'IPCA', 'IBOV'])).min(1),
    default: ['CDI', 'IPCA', 'IBOV'],
    levels: ['user'],
    description: 'Benchmark series shown alongside the user’s own return (FR-5.4).',
    range: "non-empty array of: 'CDI', 'IPCA', 'IBOV'",
  },
  'ui.theme': {
    key: 'ui.theme',
    schema: z.enum(['system', 'light', 'dark']),
    default: 'system',
    levels: ['user'],
    // DL-03: the persisted half of the three-state theming in globals.css.
    // 'system' stamps no class and lets prefers-color-scheme decide; the other
    // two stamp .light / .dark, which win over it.
    description: 'Interface theme — follow the operating system, or force light or dark (DL-03).',
    range: "one of: 'system', 'light', 'dark'",
  },
  'auth.session_idle_days': {
    key: 'auth.session_idle_days',
    schema: z.number().int().min(1).max(365),
    default: 30,
    levels: ['deployment'],
    description: 'Idle days before a session expires (FR-1.4).',
    range: 'integer, 1–365',
  },
  'retention.audit_months': {
    key: 'retention.audit_months',
    schema: z.number().int().min(1).max(120),
    default: 12,
    levels: ['deployment'],
    description: 'Months an AuditLog entry is retained before purge (FR-8.17).',
    range: 'integer, 1–120',
  },
  'retention.deletion_window_days': {
    key: 'retention.deletion_window_days',
    // DL-002-04: a compliance parameter is configurable only within a range
    // that cannot be set to an unlawful value — never down to 0 (immediate,
    // unrecoverable deletion) and never past a year.
    schema: z.number().int().min(7).max(365),
    default: 30,
    levels: ['deployment'],
    description: 'Grace window between a deletion request and irreversible purge (FR-8.12).',
    range: 'integer, 7–365',
  },
  'features.ingestion_adapters': {
    key: 'features.ingestion_adapters',
    schema: z.boolean(),
    default: false,
    levels: ['deployment'],
    description: 'Feature flag for non-xlsx IngestionPort adapters, e.g. Open Finance (FR-4.5).',
    range: 'boolean',
  },
  'alerts.queue_backlog_threshold': {
    key: 'alerts.queue_backlog_threshold',
    // SPEC-016 BR-016-13/BR-016-14: thresholds are config, not code. Read by
    // src/worker/index.ts's dead-letter consumer.
    schema: z.number().int().min(1),
    default: 50,
    levels: ['deployment'],
    description:
      'Pending jobs in the dead-letter queue that raise a background-job-backlog alert (BR-016-13).',
    range: 'positive integer',
  },
  'observability.worker_heartbeat_interval_seconds': {
    key: 'observability.worker_heartbeat_interval_seconds',
    schema: z.number().int().min(5).max(3600),
    default: 30,
    levels: ['deployment'],
    description: 'How often the worker writes its liveness heartbeat (AR-50).',
    range: 'integer seconds, 5–3600',
  },
  'observability.worker_heartbeat_stale_seconds': {
    key: 'observability.worker_heartbeat_stale_seconds',
    schema: z.number().int().min(5).max(7200),
    default: 120,
    levels: ['deployment'],
    description:
      '/api/health reports the worker unhealthy once its heartbeat is older than this (AR-50).',
    range: 'integer seconds, 5–7200',
  },
} as const satisfies Record<string, RegistryEntryDef>;

export type ConfigKey = keyof typeof REGISTRY;

export type ConfigValue<K extends ConfigKey> =
  (typeof REGISTRY)[K] extends RegistryEntryDef<infer T> ? T : never;

export function isConfigKey(value: string): value is ConfigKey {
  return Object.hasOwn(REGISTRY, value);
}

/**
 * Returns the registry entry for `key`, typed as `RegistryEntryDef<ConfigValue<K>>`
 * rather than the raw `(typeof REGISTRY)[K]` indexed-access type. The cast is
 * deliberate: TypeScript cannot keep a *generic* `K`'s indexed access
 * precisely tied to `ConfigValue<K>` through further generic call sites
 * (`resolveFromLayers`, `setConfigValue`, `authorizeConfigWrite`) without it —
 * `levels` in particular would otherwise infer as a union of differently-
 * shaped readonly tuples, and `.includes(level)` would not typecheck at all.
 * Callers passing a concrete literal key (the common case) lose nothing —
 * `ConfigValue<K>` resolves to that exact key's value type either way.
 */
export function registryEntry<K extends ConfigKey>(key: K): RegistryEntryDef<ConfigValue<K>> {
  return REGISTRY[key] as unknown as RegistryEntryDef<ConfigValue<K>>;
}

export const CONFIG_KEYS = Object.keys(REGISTRY) as readonly ConfigKey[];

/**
 * Keys a signed-in user may set themselves — what the SPEC-002 preferences
 * surface (src/app/(settings)/preferences/) renders. Everything else is
 * deployment-only and, per the spec's Out of Scope, has no UI at all.
 */
export const USER_SETTABLE_KEYS = CONFIG_KEYS.filter((key) =>
  registryEntry(key).levels.includes('user'),
);
