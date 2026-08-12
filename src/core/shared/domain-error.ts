/**
 * AR-37: a domain error carries a stable code plus structured context — never a
 * pre-formatted user string. AR-38: the i18n layer turns the code into pt-BR
 * text, which is what lets SPEC-005 BR-005-05's "specific, actionable error"
 * actually be actionable.
 *
 * AR-39: context must never carry personal data. The value type below is
 * restricted to primitives on purpose — it makes it awkward to drop an entity
 * (and therefore an email, a name or a CPF) into something that will be logged
 * and sent to Sentry.
 */
export type ErrorContextValue = string | number | boolean | null;

export interface DomainError<Code extends string = string> {
  readonly code: Code;
  readonly context: Readonly<Record<string, ErrorContextValue>>;
}

export function domainError<Code extends string>(
  code: Code,
  context: Readonly<Record<string, ErrorContextValue>> = {},
): DomainError<Code> {
  return { code, context };
}

/**
 * Codes shared across specs. Spec-specific codes are declared next to the use
 * case that produces them, not accumulated here.
 */
export const SharedErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT: 'CONFLICT',
} as const;

export type SharedErrorCode = (typeof SharedErrorCode)[keyof typeof SharedErrorCode];
