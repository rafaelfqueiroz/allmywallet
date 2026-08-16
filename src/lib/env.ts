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

  /**
   * SPEC-001 (#42) — the canonical public origin, including Auth.js's base
   * path: `https://allmywallet.example.com/api/auth`.
   *
   * This is how production answers "which host do I trust". Auth.js rewrites
   * every incoming request's origin to this one before building callback URLs
   * (`next-auth/lib/env.js`'s `reqWithEnvURL`), so a spoofed `Host` or
   * `X-Forwarded-Host` header cannot redirect an OAuth callback anywhere.
   * Pinning beats trusting: the app sits behind Caddy, but nothing in the
   * network guarantees a request *reached* it through Caddy.
   *
   * Optional here for the same reason the three above are — the worker never
   * serves HTTP, and neither does a test. `assertTrustedHostConfigured()`
   * (src/lib/trusted-host.ts) is where it becomes required, narrowly, in
   * production only.
   */
  AUTH_URL: z.string().url().optional(),
  /**
   * Local and CI only: trust whatever `Host` arrives. Auth.js already does
   * this outside production (`NODE_ENV !== 'production'` is the last term of
   * its own default chain), so this matters exactly where a *production build*
   * is run against localhost — `pnpm build` in the Docker builder stage, and
   * the E2E and visual CI jobs, which serve the standalone output.
   *
   * Never set this in production. It is the option `AUTH_URL` was chosen over.
   */
  AUTH_TRUST_HOST: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /**
   * SPEC-005 — where an uploaded extract's bytes live between `import.stage`
   * and `import.commit`/`import.cancel` (BR-005-12/DL-005-07: deleted at
   * either). A filesystem path rather than a SPEC-002 config key: it is
   * infrastructure (which volume the two containers share), not an operator
   * tunable like a cadence or a threshold, and changing it means a redeploy —
   * exactly DEVELOPMENT.md's line for what belongs here instead of the
   * registry. `web` and `worker` are two commands over the *same* image
   * (ARCHITECTURE §2) sharing one Compose volume in production, so a plain
   * path is enough; there is deliberately no filename in it (see
   * `src/db/schema/transactions.ts`'s comment on why `import_batches` carries
   * none) — files are named by `batchId` alone.
   */
  IMPORT_UPLOAD_DIR: z.string().default('.data/imports'),
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
