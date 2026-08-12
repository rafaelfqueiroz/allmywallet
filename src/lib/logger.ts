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

export const logger = pino({
  level: level(),
  // Structured JSON, so the VPS log shipper and any future Loki query see the
  // same shape. Never pretty-print in production.
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    // AR-48 in log form. Sentry gets its own scrubbing configuration.
    paths: ['email', '*.email', 'name', '*.name', 'cpf', '*.cpf', 'password', '*.password'],
    remove: true,
  },
});

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
