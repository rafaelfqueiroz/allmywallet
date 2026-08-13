import { createHash } from 'node:crypto';
import pino from 'pino';

/**
 * AR-49: logs carry a correlation id and, where relevant, a *hashed* user id —
 * never an email, a name or a CPF.
 *
 * SPEC-004 BR-004-04 makes this a compliance requirement rather than hygiene:
 * personal data must not reach logs at all, so the log helpers below take
 * structured facts and refuse to be handed an entity.
 */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Read directly from `process.env` rather than through `env()`, which is the one
 * deliberate exception to AR-43's "one place reads the environment". The logger
 * has to be importable where there is no database — including inside the
 * failure path that reports *why* `env()` could not be parsed. Routing it
 * through `env()` would mean a bad `DATABASE_URL` produced a crash with no log
 * line explaining it.
 */
function level(): pino.Level {
  const configured = process.env.LOG_LEVEL;
  return LEVELS.includes(configured as pino.Level) ? (configured as pino.Level) : 'info';
}

/** Key names that must never survive into a log line, at any depth, case-insensitively. */
const FORBIDDEN_KEYS = new Set(['email', 'name', 'cpf', 'password']);

/**
 * `redact.paths` below only reaches the top level and exactly one level deep
 * (`*.email`) — `fast-redact` (pino's redaction engine) has no recursive
 * wildcard, so a value nested further — `importRow.raw_payload.cpf`
 * (SPEC-004 BR-004-04's own named example) — would sail through it
 * untouched. This walks the *entire* log object recursively before
 * serialization and is what actually makes "personal data must not reach
 * logs at all" true regardless of nesting depth; `redact` stays as a second,
 * independent layer for the common top-level/one-level case rather than
 * being removed now that this exists.
 */
function scrubPersonalData(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubPersonalData(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    result[key] = scrubPersonalData(entry, depth + 1);
  }
  return result;
}

/**
 * Exported so `logger.test.ts` (SPEC-016 BR-016-12) can build a second pino
 * instance against an in-memory stream with the *exact* configuration
 * production uses, rather than duplicating it and risking it drifting from
 * what actually ships — "must scrub" is asserted against this object, not
 * assumed from reading it.
 */
export const LOGGER_OPTIONS: pino.LoggerOptions = {
  level: level(),
  formatters: {
    // Structured JSON, so the VPS log shipper and any future Loki query see
    // the same shape. Never pretty-print in production.
    level: (label) => ({ level: label }),
    // Runs before serialization/redaction — this is the recursive scrub
    // described above, on the fully merged object (bindings + fields).
    log: (object) => scrubPersonalData(object) as Record<string, unknown>,
  },
  redact: {
    // AR-48 in log form. Sentry gets its own scrubbing configuration. Kept
    // alongside the recursive scrub above, not replaced by it — two
    // independent mechanisms are less likely to both have the same blind spot.
    paths: ['email', '*.email', 'name', '*.name', 'cpf', '*.cpf', 'password', '*.password'],
    remove: true,
  },
};

export const logger = pino(LOGGER_OPTIONS);

/**
 * A stable, non-reversible identifier for correlating a user's requests without
 * storing who they are. Truncated to 16 hex chars: enough to correlate, short
 * enough that nobody is tempted to treat it as an id.
 */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

export type LogContext = Record<string, string | number | boolean | null>;

export function childLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}
