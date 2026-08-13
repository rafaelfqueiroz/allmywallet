import { z } from 'zod';

/**
 * AR-43: secrets are read from the environment only. They never enter the
 * SPEC-002 config registry, and they are excluded from the effective-config
 * view, logs and Sentry.
 *
 * This file holds *only* secrets and connection details. Anything an operator
 * would plausibly want to tune at runtime — cadences, thresholds, budgets —
 * belongs in the registry instead (SPEC-002 BR-002-01), because changing it
 * here means a redeploy.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Runtime connection, as the restricted `allmywallet_app` role (AR-11). */
  DATABASE_URL: z.string().url(),
  /** Migrations only, as `allmywallet_migrator`. Absent at runtime by design. */
  DATABASE_MIGRATION_URL: z.string().url().optional(),

  // Optional *here* deliberately: env.ts is imported by every process,
  // including the worker (which never touches auth) and every test file
  // (transitively, via src/db/client.ts) — making these required at this
  // level would force every one of them to carry Google OAuth credentials
  // just to boot. SPEC-001 does require them present wherever auth is
  // actually used — src/auth.ts's `requireAuthEnv()` enforces that,
  // narrowly, and fails startup there (AR-40/AR-41) rather than here.
  AUTH_SECRET: z.string().min(32).optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail the boot rather than fall back (the same reasoning as BR-002-04):
    // a missing DATABASE_URL that defaults to localhost is a worse outcome than
    // not starting.
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — lets a suite install a fixture environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
