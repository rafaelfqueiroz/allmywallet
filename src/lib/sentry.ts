import type { ErrorEvent, Event, EventHint } from '@sentry/nextjs';

/**
 * `@sentry/nextjs`'s package `exports` map does not surface `TransactionEvent`
 * under this project's `moduleResolution: "bundler"` (`Event`, `ErrorEvent`
 * and `EventHint` all do) — structurally identical to the SDK's own
 * `TransactionEvent` (`Event & { type: 'transaction' }`), declared locally
 * rather than fought with a resolution-mode workaround for one type import.
 */
type TransactionEvent = Event & { type: 'transaction' };

/**
 * AR-48: Sentry must be configured to scrub request bodies, headers and query
 * strings. It captures them by default — `request.data`, `request.headers`
 * and `request.query_string` are populated automatically by the Next.js SDK's
 * request integration — which would violate SPEC-004 BR-004-04 (no personal
 * data in logs or errors) on day one, since a request body or an auth cookie
 * can carry exactly the personal data BR-004-04 exists to keep out.
 *
 * This module is deliberately pure and framework-import-light (only the
 * `@sentry/nextjs` *types*, never its runtime) so the scrubbing behaviour is
 * unit-testable without booting Sentry or Next.js — `sentry.server.config.ts`
 * and `sentry.edge.config.ts` are the only places `Sentry.init` is actually
 * called, and both just pass this module's output through unchanged.
 */

/** Fields stripped from every event's `request` block, in addition to `sendDefaultPii: false`. */
const SCRUBBED_REQUEST_FIELDS = ['data', 'headers', 'cookies', 'query_string'] as const;

/**
 * Options shared by every Sentry entrypoint (server, edge — there is no
 * client-side entrypoint yet, since nothing under `src/app` ships
 * client-side error reporting today). Kept in one place so the scrubbing
 * behaviour cannot drift between them.
 */
export function baseSentryOptions(dsn: string | undefined): {
  dsn: string | undefined;
  // SPEC-004 BR-004-04: Sentry's default behaviour sends the reporter's IP,
  // and — for server-side events — full request headers and cookies. `false`
  // is what turns that default off; `beforeSend` below is the second,
  // belt-and-braces layer that strips the fields explicitly even if a future
  // SDK version changes what `sendDefaultPii` covers.
  sendDefaultPii: false;
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  beforeSendTransaction: (event: TransactionEvent, hint: EventHint) => TransactionEvent | null;
} {
  return {
    dsn,
    sendDefaultPii: false,
    beforeSend: (event, hint) => scrubEvent(event, hint) as ErrorEvent,
    beforeSendTransaction: (event, hint) => scrubEvent(event, hint) as TransactionEvent,
  };
}

/**
 * The explicit scrub, operating on the base `Event` shape shared by
 * `ErrorEvent` and `TransactionEvent` — scrubbing never adds a field, only
 * removes ones the discriminant `type` doesn't care about, so `baseSentryOptions`
 * casting the result back to the specific event type above is safe.
 *
 * Exported on its own so a test can assert directly that a request body,
 * header set or query string handed to it does not survive — "must be
 * configured to scrub" is a claim about behaviour, not about an option being
 * set, and this is what makes that claim checkable without a live Sentry
 * project.
 *
 * Builds a fresh object rather than mutating `event` in place — `Event`'s
 * fields are optional under `exactOptionalPropertyTypes` (DV-01), which
 * distinguishes "absent" from "present and undefined"; conditionally
 * spreading is what keeps a scrubbed-to-nothing `request`/`user` block
 * genuinely absent rather than present-but-empty.
 */
export function scrubEvent<E extends Event>(event: E, _hint: EventHint): E {
  const { request, user, ...rest } = event;

  const scrubbedRequest = request
    ? Object.fromEntries(
        Object.entries(request).filter(
          ([key]) => !(SCRUBBED_REQUEST_FIELDS as readonly string[]).includes(key),
        ),
      )
    : undefined;

  // AR-49 companion: the ip_address field is dropped by sendDefaultPii
  // already, but scrubbed again here in case an integration re-attaches it
  // downstream of that flag (e.g. a manually-constructed event).
  const scrubbedUser = user
    ? Object.fromEntries(
        Object.entries(user).filter(([key]) => !['ip_address', 'email', 'username'].includes(key)),
      )
    : undefined;

  return {
    ...rest,
    ...(scrubbedRequest ? { request: scrubbedRequest } : {}),
    ...(scrubbedUser ? { user: scrubbedUser } : {}),
  } as E;
}
