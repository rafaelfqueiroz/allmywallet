import { describe, expect, it } from 'vitest';
import { rowPage, rowTableAddressed, rowTableOptions } from './row-pages';
import { writeTableUrlState } from '@/lib/table-url-state';

const items = Array.from({ length: 120 }, (_, i) => i);

describe('rowPage (SPEC-022 BR-022-18)', () => {
  it('opens on ten rows', () => {
    const first = rowPage(items, {}, 'attention');
    expect(first).toMatchObject({ page: 1, pageSize: 10, total: 120 });
    expect(first.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('pages in the table’s own prefixed parameters, leaving the other tables where they were', () => {
    const query = { atencao_page: '3', ignoradas_page: '2', ignoradas_size: '25' };
    expect(rowPage(items, query, 'attention')).toMatchObject({ page: 3, pageSize: 10 });
    expect(rowPage(items, query, 'attention').rows[0]).toBe(20);
    expect(rowPage(items, query, 'ignored')).toMatchObject({ page: 2, pageSize: 25 });
    expect(rowPage(items, query, 'ignored').rows[0]).toBe(25);
    expect(rowPage(items, query, 'summary')).toMatchObject({ page: 1, pageSize: 10 });
  });

  it.each([10, 25, 50])('offers a page size of %i', (size) => {
    const page = rowPage(items, { atencao_size: String(size) }, 'attention');
    expect(page.pageSize).toBe(size);
    expect(page.rows).toHaveLength(size);
  });

  it('refuses a page size it does not offer instead of rounding it', () => {
    expect(rowPage(items, { atencao_size: '30' }, 'attention').pageSize).toBe(10);
    expect(rowPage(items, { atencao_size: '100' }, 'attention').pageSize).toBe(10);
  });

  it('clamps a missing, malformed or out-of-range page instead of emptying the table', () => {
    expect(rowPage(items, {}, 'attention').page).toBe(1);
    expect(rowPage(items, { atencao_page: 'abc' }, 'attention').page).toBe(1);
    expect(rowPage(items, { atencao_page: '0' }, 'attention').page).toBe(1);
    expect(rowPage(items, { atencao_page: '99' }, 'attention').page).toBe(12);
    expect(rowPage(items, { atencao_page: ['2', '3'] }, 'attention').page).toBe(2);
    expect(rowPage([], { atencao_page: '4' }, 'attention')).toEqual({
      page: 1,
      pageSize: 10,
      rows: [],
      total: 0,
    });
  });

  it('ignores a sort: the rows come in the batch’s own order', () => {
    const sorted = rowPage(items, { atencao_sort: 'asset:desc' }, 'attention');
    expect(sorted.rows[0]).toBe(0);
  });
});

describe('rowTableOptions', () => {
  it('is what the table writes with: its links round-trip through the server’s parse', () => {
    // `DataTable` server mode builds the next URL with `writeTableUrlState`; the
    // page reads it back with `rowPage`. A drift between the two would page a
    // different window than the one the link names.
    const options = rowTableOptions('ignored');
    const query = writeTableUrlState('', { sort: null, page: 3, pageSize: 25, query: '' }, options);
    const params = Object.fromEntries(new URLSearchParams(query));
    expect(params).toEqual({ ignoradas_page: '3', ignoradas_size: '25' });
    expect(rowPage(items, params, 'ignored')).toMatchObject({ page: 3, pageSize: 25 });
  });
});

describe('rowTableAddressed', () => {
  it('says whether the URL names the table at all, so Ignoradas renders open on it', () => {
    expect(rowTableAddressed({ ignoradas_page: '2' }, 'ignored')).toBe(true);
    expect(rowTableAddressed({ ignoradas_size: '50' }, 'ignored')).toBe(true);
    expect(rowTableAddressed({ atencao_page: '2' }, 'ignored')).toBe(false);
    expect(rowTableAddressed({}, 'ignored')).toBe(false);
  });
});
