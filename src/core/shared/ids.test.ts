import { describe, expect, it } from 'vitest';
import { AssetId, UserId, WalletId, isUuid } from './ids';

describe('branded identifiers', () => {
  it('generates time-ordered UUIDv7 values (AR-25)', () => {
    const first = UserId.generate();
    const second = UserId.generate();
    expect(isUuid(first)).toBe(true);
    // v7 sorts by creation time as a string, which is what makes it index well.
    expect(first <= second).toBe(true);
  });

  it('refuses a string that is not a UUID', () => {
    // Ids are interpolated into `current_setting('app.user_id')::uuid`
    // comparisons (AR-11); an empty string or a fragment must not get that far.
    expect(() => UserId.of('')).toThrow(TypeError);
    expect(() => UserId.of('not-a-uuid')).toThrow(TypeError);
    expect(() => UserId.of("' OR 1=1 --")).toThrow(TypeError);
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
