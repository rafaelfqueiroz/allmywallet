import { describe, expect, it } from 'vitest';
import {
  AssetId,
  ImportBatchId,
  InstitutionId,
  PositionId,
  TransactionId,
  UserId,
  WalletId,
  isUuid,
} from './ids';

/**
 * The invariants are shared across every id kind, so they are asserted across
 * every kind — a new id type that forgets to validate is exactly the sort of
 * thing that gets noticed only when a malformed value reaches a `::uuid` cast
 * in an RLS predicate.
 */
const kinds = [
  ['UserId', UserId],
  ['AssetId', AssetId],
  ['WalletId', WalletId],
  ['TransactionId', TransactionId],
  ['PositionId', PositionId],
  ['ImportBatchId', ImportBatchId],
  ['InstitutionId', InstitutionId],
] as const;

describe('branded identifiers', () => {
  it.each(kinds)('%s generates a valid UUIDv7 and round-trips through `of`', (_name, kind) => {
    const generated = kind.generate();
    expect(isUuid(generated)).toBe(true);
    expect(kind.of(generated)).toBe(generated);
  });

  it.each(kinds)('%s refuses a string that is not a UUID', (_name, kind) => {
    // Ids are interpolated into `current_setting('app.user_id')::uuid`
    // comparisons (AR-11); an empty string or a fragment must not get that far.
    expect(() => kind.of('')).toThrow(TypeError);
    expect(() => kind.of('not-a-uuid')).toThrow(TypeError);
    expect(() => kind.of("' OR 1=1 --")).toThrow(TypeError);
  });

  it('generates time-ordered values (AR-25)', () => {
    // v7 sorts by creation time as a string, which is what makes it cluster in
    // the index instead of scattering writes across the B-tree the way v4 does.
    const generated = Array.from({ length: 20 }, () => UserId.generate());
    expect([...generated].sort()).toEqual(generated);
  });

  it('stamps version 7 in what it generates', () => {
    // The version nibble opens the third group. `of()` deliberately does not
    // enforce it — it validates ids arriving from outside, including Auth.js
    // adapter rows — so the guarantee has to be asserted at the generator.
    expect(UserId.generate().split('-')[2]?.[0]).toBe('7');
  });

  it('keeps distinct id kinds distinct at the type level (DV-05)', () => {
    const wallet = WalletId.generate();
    const asset = AssetId.generate();
    // @ts-expect-error passing an AssetId where a WalletId belongs must not compile
    const wrong: WalletId = asset;
    expect(typeof wallet).toBe('string');
    expect(typeof wrong).toBe('string');
  });
});
