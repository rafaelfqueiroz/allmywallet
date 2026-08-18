import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { AssetId, InstitutionId, WalletId } from '@/core/shared/ids';
import {
  PAGE_SIZE,
  PARAM,
  fromSearchParams,
  hasActiveFilters,
  paginationFor,
  toQueryString,
} from '@/lib/transactions-url-state';

/** SPEC-006 BR-006-07/08/09/10 — the transaction history's URL state. */

const parse = (query: string) => fromSearchParams(new URLSearchParams(query));

describe('fromSearchParams', () => {
  it('defaults to page 1 and no constraints when nothing is set', () => {
    const state = parse('');
    expect(state.page).toBe(1);
    expect(state.filter).toEqual({
      from: undefined,
      to: undefined,
      assetIds: undefined,
      assetClasses: undefined,
      types: undefined,
      institutionIds: undefined,
      statuses: undefined,
      walletId: undefined,
      search: undefined,
    });
  });

  it('parses a full combination of filters independently', () => {
    const assetId = '01920000-0000-7000-8000-00000000a001';
    const institutionId = '01920000-0000-7000-8000-00000000b001';
    const walletId = '01920000-0000-7000-8000-00000000c001';
    const state = parse(
      `from=2026-01-01&to=2026-06-30&asset=${assetId}&assetClass=fii&type=buy&institution=${institutionId}&status=active&wallet=${walletId}&q=petr4&page=3`,
    );

    expect(state.filter.from).toBe(BusinessDate.of('2026-01-01'));
    expect(state.filter.to).toBe(BusinessDate.of('2026-06-30'));
    expect(state.filter.assetIds).toEqual([AssetId.of(assetId)]);
    expect(state.filter.assetClasses).toEqual(['fii']);
    expect(state.filter.types).toEqual(['buy']);
    expect(state.filter.institutionIds).toEqual([InstitutionId.of(institutionId)]);
    expect(state.filter.statuses).toEqual(['active']);
    expect(state.filter.walletId).toBe(WalletId.of(walletId));
    expect(state.filter.search).toBe('petr4');
    expect(state.page).toBe(3);
  });

  // BR-011's lesson, applied here: two URL parameters encoding one concept can
  // disagree. This module has exactly one parameter per dimension, so there is
  // nothing to test for that failure mode directly — instead each malformed
  // value is asserted to fall back independently, proving no field leaks into
  // another's parsing.
  it.each([
    ['from', 'not-a-date'],
    ['to', '2026-02-31'],
    ['asset', 'not-a-uuid'],
    ['assetClass', 'crypto'],
    ['type', 'not-a-type'],
    ['institution', 'not-a-uuid'],
    ['status', 'not-a-status'],
    ['wallet', 'not-a-uuid'],
    // The exact value the "todas as carteiras" option posts. It has to read as
    // "no constraint" rather than as a wallet whose id is the empty string,
    // which would filter the list down to nothing.
    ['wallet', ''],
  ])('falls back to no constraint for a malformed %s', (param, value) => {
    const state = parse(`${param}=${encodeURIComponent(value)}`);
    // Every field resolves to "no constraint" — a malformed value must not
    // throw and must not leak into some other field's slot.
    expect(Object.values(state.filter).every((v) => v === undefined)).toBe(true);
  });

  it('ignores a blank search term', () => {
    expect(parse('q=%20%20').filter.search).toBeUndefined();
  });

  it.each([['0'], ['-1'], ['1.5'], ['not-a-number'], ['']])(
    'falls back to page 1 for %s',
    (raw) => {
      expect(parse(`page=${raw}`).page).toBe(1);
    },
  );

  it('accepts a valid later page', () => {
    expect(parse('page=7').page).toBe(7);
  });
});

describe('paginationFor', () => {
  it('converts a 1-based page into limit/offset', () => {
    expect(paginationFor(1)).toEqual({ limit: PAGE_SIZE, offset: 0 });
    expect(paginationFor(2)).toEqual({ limit: PAGE_SIZE, offset: PAGE_SIZE });
    expect(paginationFor(3)).toEqual({ limit: PAGE_SIZE, offset: PAGE_SIZE * 2 });
  });
});

describe('toQueryString', () => {
  it('is empty when there is nothing to carry', () => {
    expect(toQueryString(new URLSearchParams(''))).toBe('');
  });

  it('carries every filter but never the page by default', () => {
    const params = new URLSearchParams('type=buy&status=active&page=5');
    const query = toQueryString(params);
    expect(query).toContain('type=buy');
    expect(query).toContain('status=active');
    expect(query).not.toContain('page=');
  });

  it('adds the page only when asked for and greater than 1', () => {
    const params = new URLSearchParams('type=buy');
    expect(toQueryString(params, 1)).not.toContain(PARAM.page);
    expect(toQueryString(params, 2)).toContain(`${PARAM.page}=2`);
  });

  it('round-trips filters through fromSearchParams unchanged', () => {
    const source = new URLSearchParams('from=2026-01-01&type=sell&q=vale&page=4');
    const rebuilt = fromSearchParams(new URLSearchParams(toQueryString(source, 4)));
    expect(rebuilt).toEqual(fromSearchParams(source));
  });
});

describe('hasActiveFilters', () => {
  it('is false when every field is unset', () => {
    expect(hasActiveFilters(parse('').filter)).toBe(false);
    // A page number alone is not a filter — BR-006-08's controls, not pagination.
    expect(hasActiveFilters(parse('page=3').filter)).toBe(false);
  });

  it('is true when exactly one filter is set', () => {
    expect(hasActiveFilters(parse('q=petr4').filter)).toBe(true);
    expect(hasActiveFilters(parse('status=unclassified').filter)).toBe(true);
  });

  it('is true when a malformed value still resolves to a real constraint', () => {
    // `to` alone parses; the case that matters here is that *any* one
    // resolved field is enough, independent of how many others failed.
    expect(hasActiveFilters(parse('to=2026-06-30&type=not-a-type').filter)).toBe(true);
  });
});
