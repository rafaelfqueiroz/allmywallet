import { describe, expect, it } from 'vitest';
import { parseSnapshotJobPayload } from '@/worker/handlers/valuation';

/**
 * AR-21: the `valuation.snapshot` payload is JSON from another process
 * (`boss.send` in the import handler, the fixed-income action, the Tesouro
 * sync). Its shape is validated here, never cast.
 */
describe('parseSnapshotJobPayload', () => {
  const USER = '01920000-0000-7000-8000-000000000009';

  it.each([null, undefined, {}])('%j means every tenant, whole history', (data) => {
    expect(parseSnapshotJobPayload(data)).toEqual({});
  });

  it('keeps a valid userId and from', () => {
    expect(parseSnapshotJobPayload({ userId: USER, from: '2026-03-18' })).toEqual({
      userId: USER,
      from: '2026-03-18',
    });
  });

  it('ignores keys it does not own', () => {
    expect(parseSnapshotJobPayload({ from: '2026-03-18', batchId: 'x' })).toEqual({
      from: '2026-03-18',
    });
  });

  it.each([
    ['a string', 'full'],
    ['a number', 42],
    ['an array', [USER]],
    ['a numeric from', { from: 20260318 }],
    ['a non-ISO from', { from: '18/03/2026' }],
    ['an impossible from', { from: '2026-02-31' }],
    ['a numeric userId', { userId: 7 }],
    ['a non-UUID userId', { userId: "x' OR 1=1" }],
  ])('rejects %s', (_label, data) => {
    expect(() => parseSnapshotJobPayload(data)).toThrow(TypeError);
  });
});
