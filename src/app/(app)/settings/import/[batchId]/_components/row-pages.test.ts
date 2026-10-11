import { describe, expect, it } from 'vitest';
import { rowPage, rowPageHref } from './row-pages';

const items = Array.from({ length: 120 }, (_, i) => i);

describe('rowPage (SPEC-022 BR-022-18)', () => {
  it('returns the requested page of fifty', () => {
    const second = rowPage(items, '2');
    expect(second).toMatchObject({ page: 2, total: 120 });
    expect(second.rows[0]).toBe(50);
    expect(second.rows).toHaveLength(50);
    expect(rowPage(items, '3').rows).toHaveLength(20);
  });

  it('clamps a missing, malformed or out-of-range page instead of emptying the table', () => {
    expect(rowPage(items, undefined).page).toBe(1);
    expect(rowPage(items, 'abc').page).toBe(1);
    expect(rowPage(items, '0').page).toBe(1);
    expect(rowPage(items, '9').page).toBe(3);
    expect(rowPage(items, ['2', '3']).page).toBe(2);
    expect(rowPage([], '4')).toEqual({ page: 1, rows: [], total: 0 });
  });
});

describe('rowPageHref', () => {
  it('moves one table and keeps the others, anchored to the table', () => {
    expect(rowPageHref('/settings/import/b', { ignored: 3 }, 'attention', 2)).toBe(
      '/settings/import/b?atencao=2&ignoradas=3#attention',
    );
    expect(rowPageHref('/settings/import/b', { attention: 2, summary: 1 }, 'attention', 1)).toBe(
      '/settings/import/b?atencao=1#attention',
    );
  });

  it('keeps the paged table on the URL at page 1, so Ignoradas stays open going back', () => {
    const back = new URL(
      rowPageHref('/settings/import/b', { ignored: 2 }, 'ignored', 1),
      'http://localhost',
    );
    expect(back.searchParams.get('ignoradas')).toBe('1');
    expect(back.hash).toBe('#ignored');
  });
});
