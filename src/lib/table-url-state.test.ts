import { describe, expect, it } from 'vitest';
import {
  pageWindow,
  parseTableUrlState,
  tableParamNames,
  writeTableUrlState,
  type TableUrlOptions,
} from '@/lib/table-url-state';

const options: TableUrlOptions = {
  pageSizeOptions: [10, 25, 50, 100],
  sortableIds: ['code', 'value'],
  defaults: { sort: { id: 'value', desc: true }, pageSize: 25 },
};

const parse = (query: string, opts: TableUrlOptions = options) =>
  parseTableUrlState(new URLSearchParams(query), opts);

describe('parseTableUrlState', () => {
  it('returns the defaults for an empty query string', () => {
    expect(parse('')).toEqual({
      sort: { id: 'value', desc: true },
      page: 1,
      pageSize: 25,
      query: '',
    });
  });

  it('reads every parameter', () => {
    expect(parse('sort=code:asc&page=3&size=50&q=%20petr%20')).toEqual({
      sort: { id: 'code', desc: false },
      page: 3,
      pageSize: 50,
      query: 'petr',
    });
  });

  it('treats an empty sort as "no sort", not as the default', () => {
    expect(parse('sort=').sort).toBeNull();
  });

  it.each(['code', 'code:', ':asc', 'code:up', 'unknown:asc', 'value:ASC'])(
    'falls back to the default for an unreadable sort (%s)',
    (raw) => {
      expect(parse(`sort=${raw}`).sort).toEqual({ id: 'value', desc: true });
    },
  );

  it.each(['0', '-1', 'abc', '1.5', '', '1e3', '9999999999'])(
    'falls back to page 1 for an unreadable page (%s)',
    (raw) => {
      expect(parse(`page=${raw}`).page).toBe(1);
    },
  );

  it.each(['30', '0', 'many', ''])(
    'never rounds a page size it does not offer into one it does (%s)',
    (raw) => {
      expect(parse(`size=${raw}`).pageSize).toBe(25);
    },
  );

  it('bounds the filter text', () => {
    expect(parse(`q=${'x'.repeat(500)}`).query).toHaveLength(100);
  });

  it('namespaces every parameter under a prefix', () => {
    const prefixed = { ...options, prefix: 'imports' };
    expect(parse('imports_page=2&imports_q=abc&page=9&q=zzz', prefixed)).toMatchObject({
      page: 2,
      query: 'abc',
    });
    expect(tableParamNames('imports').size).toBe('imports_size');
  });
});

describe('writeTableUrlState', () => {
  const defaults = parse('');

  it('writes nothing for the default view', () => {
    expect(writeTableUrlState('', defaults, options)).toBe('');
  });

  it('writes only what differs from the default', () => {
    const next = writeTableUrlState(
      '',
      { sort: { id: 'code', desc: false }, page: 2, pageSize: 50, query: ' petr ' },
      options,
    );
    expect(new URLSearchParams(next).get('sort')).toBe('code:asc');
    expect(new URLSearchParams(next).get('page')).toBe('2');
    expect(new URLSearchParams(next).get('size')).toBe('50');
    expect(new URLSearchParams(next).get('q')).toBe('petr');
  });

  it('writes an explicit empty sort when the user cleared it', () => {
    const next = writeTableUrlState('', { ...defaults, sort: null }, options);
    expect(next).toBe('sort=');
    expect(parse(next).sort).toBeNull();
  });

  it('preserves parameters it does not own', () => {
    const next = writeTableUrlState('wallet=abc&page=4', { ...defaults, query: 'x' }, options);
    const params = new URLSearchParams(next);
    expect(params.get('wallet')).toBe('abc');
    expect(params.get('q')).toBe('x');
    expect(params.has('page')).toBe(false);
  });

  it('round-trips through the parser', () => {
    const state = { sort: { id: 'code', desc: true }, page: 7, pageSize: 10, query: 'fii' };
    expect(parse(writeTableUrlState('', state, options))).toEqual(state);
  });

  it('leaves another table’s prefixed parameters alone', () => {
    const prefixed = { ...options, prefix: 'a' };
    const next = writeTableUrlState('b_page=3', { ...defaults, query: 'x' }, prefixed);
    expect(new URLSearchParams(next).get('b_page')).toBe('3');
    expect(new URLSearchParams(next).get('a_q')).toBe('x');
  });
});

describe('pageWindow', () => {
  it('shows every page when there are few', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it('centres on the current page', () => {
    expect(pageWindow(10, 40)).toEqual([8, 9, 10, 11, 12]);
  });

  it('slides at both ends rather than shrinking', () => {
    expect(pageWindow(1, 40)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(40, 40)).toEqual([36, 37, 38, 39, 40]);
  });

  it('is empty for a table with no pages', () => {
    expect(pageWindow(1, 0)).toEqual([]);
  });
});
