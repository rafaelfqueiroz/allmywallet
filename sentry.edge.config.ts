import * as Sentry from '@sentry/nextjs';
import { baseSentryOptions } from '@/lib/sentry';

/**
 * Loaded by `src/instrumentation.ts#register()` for the edge runtime
 * (middleware, edge route handlers — none exist yet, but Auth.js's default
 * middleware can run here). Same scrubbing as the Node.js runtime
 * (`sentry.server.config.ts`) via the shared `baseSentryOptions` — AR-48
 * applies regardless of which runtime handled the request.
 */
Sentry.init({
  ...baseSentryOptions(process.env.SENTRY_DSN),
  tracesSampleRate: 0.1,
});
