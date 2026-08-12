import type { DomainError } from './domain-error';

/**
 * AR-36: use cases return `Result`, they do not throw for expected outcomes.
 *
 * The split is deliberate and load-bearing (ARCHITECTURE §9):
 *   - expected domain outcomes — selling more than held, an unparseable file —
 *     are values the UI must render meaningfully;
 *   - genuine faults — database unreachable, a bug — are thrown, caught at the
 *     boundary, and reported to Sentry.
 *
 * A `Result` is a plain object so it survives the server-action JSON boundary
 * intact, unlike a class instance or an Error.
 */
export type Result<T, E = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Collects a list of results into a result of a list, failing on the first
 * error. Used where a batch must be all-or-nothing — an import commit, for
 * instance, which SPEC-005 requires to be atomic.
 */
export function allResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
