import * as Sentry from '@sentry/nextjs';
import { baseSentryOptions } from '@/lib/sentry';

/**
 * Loaded by `src/instrumentation.ts#register()` for the Node.js runtime.
 * AR-48: `baseSentryOptions` is the single place `sendDefaultPii` and the
 * scrubbing hooks are set — this file never duplicates or overrides them.
 *
 * `dsn: undefined` (SENTRY_DSN unset — the common case in development and CI)
 * makes the SDK a no-op rather than throwing; `env.ts` already validates the
 * variable's shape (a plain optional string) and this file never reads a
 * secret directly beyond passing it through `process.env`, since importing
 * `@/lib/env` here would pull the database-connection schema into a module
 * loaded before `register()`'s own config validation has run.
 */
Sentry.init({
  ...baseSentryOptions(process.env.SENTRY_DSN),
  // Errors matter far more than performance traces at this stage (Out of
  // Scope: "Real-user monitoring and analytics" — ARCHITECTURE §12 phases
  // full tracing into M4 alongside OpenTelemetry). Kept low rather than zero
  // so a trace is occasionally available to correlate with an error.
  tracesSampleRate: 0.1,
});
