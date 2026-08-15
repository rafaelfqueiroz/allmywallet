import { describe, expect, it } from 'vitest';
import {
  compareGroupKeys,
  defaultGroupingFor,
  groupKeyResolver,
  isGrouping,
} from '@/core/reporting/grouping';
import {
  GROUPINGS,
  NOT_CLASSIFIED_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  type GroupKey,
} from '@/core/reporting/ports';
import { aHolding, assetIdOf, institutionIdOf, walletIdOf } from '@/core/reporting/test-support';

/**
 * SPEC-011 BR-011-03/04/06/09/10, AC-4/AC-5/AC-7/AC-8.
 *
 * The resolver is the single point where a holding is assigned to a group, so
 * these tests are the specification of that assignment. TS-04: every expected
 * key is written out literally, never read back from the implementation.
 */

describe('groupKeyResolver — BR-011-03, the five dimensions', () => {
  it('groups by asset class', () => {
    const resolve = groupKeyResolver('asset_class');
    expect(resolve(aHolding({ assetClass: 'fii' }))).toEqual({
      dimension: 'asset_class',
      id: 'fii',
      synthetic: false,
    });
    expect(resolve(aHolding({ assetClass: 'tesouro_direto' }))).toEqual({
      dimension: 'asset_class',
      id: 'tesouro_direto',
      synthetic: false,
    });
  });

  it('groups by individual asset', () => {
    const resolve = groupKeyResolver('asset');
    const id = assetIdOf('7');
    expect(resolve(aHolding({ assetId: id }))).toEqual({
      dimension: 'asset',
      id,
      synthetic: false,
    });
  });

  it('groups by wallet', () => {
    const resolve = groupKeyResolver('wallet');
    const id = walletIdOf('3');
    expect(resolve(aHolding({ walletId: id }))).toEqual({
      dimension: 'wallet',
      id,
      synthetic: false,
    });
  });

  it('groups by sector', () => {
    const resolve = groupKeyResolver('sector');
    expect(resolve(aHolding({ sector: 'Bancos' }))).toEqual({
      dimension: 'sector',
      id: 'Bancos',
      synthetic: false,
    });
  });

  it('groups by institution', () => {
    const resolve = groupKeyResolver('institution');
    const id = institutionIdOf('2');
    expect(resolve(aHolding({ institutionId: id }))).toEqual({
      dimension: 'institution',
      id,
      synthetic: false,
    });
  });

  it('covers every dimension the type declares — no resolver is missing', () => {
    // If a sixth dimension is added to GROUPINGS without a case in the
    // resolver, this fails rather than returning undefined at runtime.
    for (const grouping of GROUPINGS) {
      const key = groupKeyResolver(grouping)(aHolding({}));
      expect(key.dimension).toBe(grouping);
      expect(typeof key.id).toBe('string');
      expect(key.id.length).toBeGreaterThan(0);
    }
  });
});

describe('BR-011-09 — Unassigned is a group, not a filter', () => {
  it('assigns an unallocated holding to the Unassigned bucket', () => {
    const resolve = groupKeyResolver('wallet');
    expect(resolve(aHolding({ walletId: null }))).toEqual({
      dimension: 'wallet',
      id: UNASSIGNED_GROUP_ID,
      synthetic: true,
    });
  });

  it('marks it synthetic so the UI can render an i18n label rather than an id', () => {
    // AR-44: the domain emits a key; the wording lives in next-intl.
    const key = groupKeyResolver('wallet')(aHolding({ walletId: null }));
    expect(key.synthetic).toBe(true);
    expect(groupKeyResolver('wallet')(aHolding({ walletId: walletIdOf('1') })).synthetic).toBe(
      false,
    );
  });
});

describe('BR-011-10 — "Not classified" is a group, not a filter', () => {
  it('assigns a holding with no sector to Not classified', () => {
    // The case the rule was written for: fixed income has no sector, and it
    // can be a large share of a Brazilian portfolio. Dropping it would make
    // the sector view disagree with every other view of the same scope.
    const resolve = groupKeyResolver('sector');
    expect(resolve(aHolding({ assetClass: 'cdb', sector: null }))).toEqual({
      dimension: 'sector',
      id: NOT_CLASSIFIED_GROUP_ID,
      synthetic: true,
    });
  });

  it('assigns a holding with no institution to Not classified', () => {
    const resolve = groupKeyResolver('institution');
    expect(resolve(aHolding({ institutionId: null }))).toEqual({
      dimension: 'institution',
      id: NOT_CLASSIFIED_GROUP_ID,
      synthetic: true,
    });
  });

  it('keeps Unassigned and Not classified as distinct buckets', () => {
    // They mean different things — "you have not filed this yet" versus "this
    // question does not apply here" — and a shared bucket would merge a
    // wallet-less holding with a sector-less one under one label.
    expect(UNASSIGNED_GROUP_ID).not.toBe(NOT_CLASSIFIED_GROUP_ID);
  });

  it('derives synthetic from the missing source value, not from the id string', () => {
    // A tenant whose sector data literally read "__not_classified__" must
    // still be treated as classified: `synthetic` follows the null, not the
    // string. This is why the resolver branches on the value, not on the key.
    const key = groupKeyResolver('sector')(aHolding({ sector: NOT_CLASSIFIED_GROUP_ID }));
    expect(key.synthetic).toBe(false);
  });
});

describe('defaultGroupingFor — BR-011-04 / AC-5', () => {
  it('defaults to asset class at portfolio scope', () => {
    expect(defaultGroupingFor({ kind: 'portfolio' }, undefined)).toBe('asset_class');
  });

  it('defaults to individual asset within a single wallet', () => {
    expect(defaultGroupingFor({ kind: 'wallet', walletId: walletIdOf('1') }, undefined)).toBe(
      'asset',
    );
  });

  it('lets a configured value override either default (SPEC-002)', () => {
    expect(defaultGroupingFor({ kind: 'portfolio' }, 'sector')).toBe('sector');
    expect(defaultGroupingFor({ kind: 'wallet', walletId: walletIdOf('1') }, 'institution')).toBe(
      'institution',
    );
  });
});

describe('isGrouping', () => {
  it('accepts exactly the five BR-011-03 dimensions', () => {
    for (const grouping of GROUPINGS) expect(isGrouping(grouping)).toBe(true);
    expect(GROUPINGS).toEqual(['asset_class', 'wallet', 'asset', 'sector', 'institution']);
  });

  it('rejects anything else, including a hand-edited URL parameter', () => {
    for (const value of ['assetClass', 'ASSET', 'currency', '', 'setor']) {
      expect(isGrouping(value)).toBe(false);
    }
  });
});

describe('compareGroupKeys — deterministic ordering', () => {
  const k = (id: string, synthetic: boolean): GroupKey => ({
    dimension: 'wallet',
    id,
    synthetic,
  });

  it('sorts synthetic buckets last', () => {
    expect(compareGroupKeys(k('zzz', false), k('aaa', true))).toBe(-1);
    expect(compareGroupKeys(k('aaa', true), k('zzz', false))).toBe(1);
  });

  it('sorts non-synthetic keys by id, ascending', () => {
    expect(compareGroupKeys(k('aaa', false), k('bbb', false))).toBe(-1);
    expect(compareGroupKeys(k('bbb', false), k('aaa', false))).toBe(1);
    expect(compareGroupKeys(k('aaa', false), k('aaa', false))).toBe(0);
  });

  it('orders two synthetic keys by id as well', () => {
    expect(compareGroupKeys(k('aaa', true), k('bbb', true))).toBe(-1);
  });

  it('produces a stable total order — sorting twice gives the same array', () => {
    // Byte-identical reruns are the point: a CSV export must not reorder
    // itself between two runs over the same data.
    const keys = [k('m', false), k('x', true), k('a', false), k('b', true), k('z', false)];
    const once = [...keys].sort(compareGroupKeys).map((key) => key.id);
    const twice = [...once.map((id) => keys.find((key) => key.id === id)!)]
      .sort(compareGroupKeys)
      .map((key) => key.id);
    expect(once).toEqual(['a', 'm', 'z', 'b', 'x']);
    expect(twice).toEqual(once);
  });
});
