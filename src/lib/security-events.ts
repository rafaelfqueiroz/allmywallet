import { childLogger, hashUserId } from '@/lib/logger';
import type { UserId } from '@/core/shared/ids';

/**
 * SPEC-003 BR-003-05: a request that supplies a tenant identifier is not
 * merely ignored — the attempt is logged as a security event. This is the one
 * place that happens, so every call site produces the same shape and nothing
 * downstream (a SIEM query, an alert rule) has to know about several.
 */

export type SecurityEventType =
  /**
   * SPEC-003 BR-003-05 / TS-17: a request body, query string or header carried
   * a `user_id` (or equivalent) that did not match the authenticated session.
   * The request proceeds using the session's own tenant — the caller's data,
   * never the one they asked for — but the attempt itself is worth knowing
   * about even when it was harmless (a stale client, a replayed request, or a
   * genuine probe).
   */
  | 'tenant_id_tamper_attempt'
  /** BR-001-10: a callback's OAuth `state`/PKCE parameter did not match. */
  | 'oauth_state_mismatch'
  /** BR-001-11 / AR-11 companion: rate limit exceeded on an auth endpoint. */
  | 'auth_rate_limit_exceeded';

export interface SecurityEvent {
  readonly type: SecurityEventType;
  /** The authenticated caller, if one exists at the time of the event. */
  readonly sessionUserId?: string;
  /** Only ever a hashed/opaque form of whatever foreign id was supplied — see `logSecurityEvent`. */
  readonly suppliedUserId?: string;
  readonly route: string;
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

const securityLogger = childLogger({ component: 'security-events' });

/**
 * AR-49 / SPEC-004 BR-004-04: personal data never reaches logs. `sessionUserId`
 * and `suppliedUserId` are hashed here — the same one-way hash used for
 * correlation elsewhere — so this event is useful for detecting a pattern
 * (the same caller probing many foreign ids) without itself becoming a record
 * of who did it.
 */
export function logSecurityEvent(event: SecurityEvent): void {
  securityLogger.warn(
    {
      securityEventType: event.type,
      ...(event.sessionUserId !== undefined
        ? { sessionUserId: hashUserId(event.sessionUserId) }
        : {}),
      ...(event.suppliedUserId !== undefined
        ? { suppliedUserId: hashUserId(event.suppliedUserId) }
        : {}),
      route: event.route,
      ...(event.context ?? {}),
    },
    `security event: ${event.type}`,
  );
}

/**
 * SPEC-003 BR-003-04 / BR-003-05: tenant identity comes from the session,
 * never from request input — and a request that supplies one anyway is not
 * silently overridden, the attempt is logged. Split out from
 * `src/lib/session.ts` (rather than living next to `requireUserId()`,
 * where it would read most naturally) purely so this stays independently
 * unit-testable: `session.ts` statically imports `@/auth`, which pulls in
 * `next-auth` and, transitively, `next/server` — a module Next.js resolves
 * fine at build/runtime but Vitest's plain Node environment cannot, so
 * nothing reachable from a `session.ts` import can be exercised as a unit
 * test. This function has no such dependency and belongs with
 * `logSecurityEvent`, which it calls, in any case.
 *
 * Never changes which id is used — the session's own id always wins, before
 * and after this call. Most call sites never see a client-supplied tenant id
 * at all (Server Components call `core/` directly with the id from
 * `requireUserId()`; server actions validate their Zod input without a
 * `userId` field in the schema in the first place); this exists for the rare
 * one that does, so the discrepancy is observable rather than silently
 * swallowed.
 */
export function assertNoTenantOverride(
  claimedUserId: string | undefined,
  sessionUserId: UserId,
  route: string,
): void {
  if (claimedUserId === undefined || claimedUserId === sessionUserId) return;
  logSecurityEvent({
    type: 'tenant_id_tamper_attempt',
    sessionUserId,
    suppliedUserId: claimedUserId,
    route,
  });
}
