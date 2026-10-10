import { describe, expect, it } from 'vitest';
import { LEGACY_REDIRECTS, toNextRedirects, type LegacyRedirect } from '@/lib/legacy-redirects';

/**
 * SPEC-022 BR-022-08 — the table's invariants, checked over whatever rows the
 * destination issues have added. A violation here is a broken old link that
 * nobody would find until an e-mail recipient clicked it.
 */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

function invariantViolations(rows: readonly LegacyRedirect[]): string[] {
  const problems: string[] = [];
  const sources = new Set<string>();

  for (const row of rows) {
    if (!row.source.startsWith('/')) problems.push(`${row.source}: source is not a path`);
    if (!row.destination.startsWith('/')) {
      // An absolute URL would send a bookmark off the instance (SPEC-021 is
      // loopback-only); a relative one stays on whatever host served it.
      problems.push(`${row.source}: destination ${row.destination} is not a local path`);
    }
    if (sources.has(row.source)) problems.push(`${row.source}: listed twice`);
    sources.add(row.source);
    if (!row.example.from.startsWith('/') || !row.example.to.startsWith('/')) {
      problems.push(`${row.source}: example is not a pair of local paths`);
    }
    if (!Number.isInteger(row.issue) || row.issue <= 0) {
      problems.push(`${row.source}: no issue`);
    }
  }

  // No chains: a destination that is itself a source costs a second
  // round-trip, and a cycle never lands at all.
  for (const row of rows) {
    if (sources.has(pathOf(row.destination))) {
      problems.push(`${row.source}: destination ${row.destination} is itself redirected`);
    }
  }

  return problems;
}

describe('legacy redirects (BR-022-08)', () => {
  it('holds every invariant over the current table', () => {
    expect(invariantViolations(LEGACY_REDIRECTS)).toEqual([]);
  });

  it('maps every row to a permanent Next redirect', () => {
    const row: LegacyRedirect = {
      source: '/wallets/:walletId/balance',
      destination: '/portfolio/wallets?wallet=:walletId',
      issue: 208,
      example: { from: '/wallets/w1/balance', to: '/portfolio/wallets?wallet=w1' },
    };

    expect(toNextRedirects([row])).toEqual([
      {
        source: '/wallets/:walletId/balance',
        destination: '/portfolio/wallets?wallet=:walletId',
        permanent: true,
      },
    ]);
  });

  // The checker itself, so an empty table is not a vacuous pass.
  it('refuses duplicates, chains, absolute destinations and rows without provenance', () => {
    const example = { from: '/a', to: '/b' };
    expect(
      invariantViolations([
        { source: '/a', destination: '/b', issue: 1, example },
        { source: '/a', destination: '/c', issue: 1, example },
        { source: '/b', destination: 'https://elsewhere.test/b', issue: 1, example },
        { source: '/d', destination: '/e', issue: 0, example },
      ]),
    ).toEqual([
      '/a: listed twice',
      '/b: destination https://elsewhere.test/b is not a local path',
      '/d: no issue',
      '/a: destination /b is itself redirected',
    ]);
  });
});
