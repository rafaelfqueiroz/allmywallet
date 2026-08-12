import { describe, expect, it } from 'vitest';
import { allResults, err, flatMapResult, isErr, isOk, mapResult, ok, unwrapOr } from './result';
import { domainError } from './domain-error';

describe('Result', () => {
  it('carries a value on success', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(result.ok && result.value).toBe(42);
  });

  it('carries a domain error on failure', () => {
    const result = err(domainError('INSUFFICIENT_QUANTITY', { held: 10, requested: 25 }));
    expect(isErr(result)).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INSUFFICIENT_QUANTITY');
      expect(result.error.context).toEqual({ held: 10, requested: 25 });
    }
  });

  it('survives the server-action JSON boundary intact (AR-34)', () => {
    const result = err(domainError('VALIDATION_FAILED', { field: 'quantity' }));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('maps only the success case', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual(ok(6));
    const failure = err(domainError('NOT_FOUND'));
    expect(mapResult(failure, (n: number) => n * 3)).toBe(failure);
  });

  it('chains and short-circuits on the first failure', () => {
    const failure = err(domainError('CONFLICT'));
    expect(flatMapResult(ok(2), (n) => ok(n + 1))).toEqual(ok(3));
    expect(flatMapResult(failure, () => ok(99))).toBe(failure);
  });

  it('collects all-or-nothing, which is what an atomic import commit needs', () => {
    expect(allResults([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));

    const failure = err(domainError('VALIDATION_FAILED', { row: 47 }));
    expect(allResults([ok(1), failure, ok(3)])).toBe(failure);
  });

  it('falls back without unwrapping a failure', () => {
    expect(unwrapOr(ok('value'), 'fallback')).toBe('value');
    expect(unwrapOr(err(domainError('NOT_FOUND')), 'fallback')).toBe('fallback');
  });
});
