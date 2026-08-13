import type { z } from 'zod';
import type { ConfigKey, ConfigLevel } from '@/config/registry';

/**
 * SPEC-002 error codes. Stable codes with structured context (AR-37) so the
 * i18n layer, not this module, decides what the operator or user reads.
 */
export const ConfigErrorCode = {
  /** BR-002-03: the key does not permit this level, or the actor lacks authority over it. */
  LEVEL_NOT_PERMITTED: 'CONFIG_LEVEL_NOT_PERMITTED',
  /** The value failed the key's Zod schema. */
  INVALID_VALUE: 'CONFIG_INVALID_VALUE',
} as const;

export type ConfigErrorCode = (typeof ConfigErrorCode)[keyof typeof ConfigErrorCode];

/**
 * BR-002-04 / DL-002-01: thrown by boot-time validation. The message names
 * the key, the offending value and the permitted range — never falls back to
 * a default, and never gets swallowed into a generic "invalid config" string.
 */
export class ConfigValidationError extends Error {
  readonly key: ConfigKey;
  readonly offendingValue: unknown;
  readonly range: string;
  readonly level: ConfigLevel | 'default';

  constructor(
    key: ConfigKey,
    offendingValue: unknown,
    range: string,
    level: ConfigLevel | 'default',
    zodError?: z.ZodError,
  ) {
    const issues = zodError ? ` (${zodError.issues.map((i) => i.message).join('; ')})` : '';
    super(
      `config key "${key}": value ${JSON.stringify(offendingValue)} at level "${level}" is outside the permitted range [${range}]${issues}`,
    );
    this.name = 'ConfigValidationError';
    this.key = key;
    this.offendingValue = offendingValue;
    this.range = range;
    this.level = level;
  }
}
