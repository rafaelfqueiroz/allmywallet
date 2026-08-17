import { describe, expect, it } from 'vitest';
import { BusinessDate } from '@/core/shared/clock';
import { WalletId } from '@/core/shared/ids';
import { GROUPINGS, type Grouping, type Period, type Scope } from '@/core/reporting/ports';
import {
  fromSearchParams,
  toQueryString,
  toSearchParams,
  type ReportUrlState,
} from '@/lib/report-url-state';

/**
 * SPEC-011 BR-011-11 / AC-10 — "copying the URL and opening it in a new
 * session reproduces the same period, scope and grouping."
 */

const WALLET = WalletId.of('01920000-0000-7000-8000-00000000b001');
const OTHER_WALLET = WalletId.of('01920000-0000-7000-8000-00000000b002');
const date = (value: string): BusinessDate => BusinessDate.of(value);

const parse = (query: string, fallback: Grouping = 'asset_class') =>
  fromSearchParams(new URLSearchParams(query), fallback);

describe('round trip — AC-10', () => {
  const PERIODS: readonly Period[] = [
    { kind: 'ytd' },
    { kind: '12m' },
    { kind: '24m' },
    { kind: 'all' },
    { kind: 'custom', from: date('2024-02-29'), to: date('2025-03-01') },
  ];
  const SCOPES: readonly Scope[] = [{ kind: 'portfolio' }, { kind: 'wallet', walletId: WALLET }];

  it('reproduces every combination of the three controls exactly', () => {
    // BR-011-05: the controls are independent and any combination is valid,
    // so the round trip is asserted over the full cross product — 5 × 2 × 5.
    for (const period of PERIODS) {
      for (const scope of SCOPES) {
        for (const grouping of GROUPINGS) {
          const state: ReportUrlState = { period, scope, grouping };
          const encoded = toSearchParams(state, 'asset_class');
          const decoded = fromSearchParams(encoded, 'asset_class');
          expect(decoded, `${period.kind}/${scope.kind}/${grouping}`).toEqual(state);
        }
      }
    }
  });

  it('survives a trip through a real query string, as a bookmark would', () => {
    const state: ReportUrlState = {
      period: { kind: 'custom', from: date('2025-01-01'), to: date('2025-12-31') },
      scope: { kind: 'wallet', walletId: WALLET },
      grouping: 'sector',
    };
    const query = toQueryString(state, 'asset_class');
    // This is what a user actually copies out of the address bar. `scope` is
    // deliberately absent: the wallet id carries the scope on its own, and a
    // second parameter that can disagree with it is what made the control
    // inert in the first place (see `parseScope`).
    expect(query).toBe(
      `?period=custom&from=2025-01-01&to=2025-12-31&wallet=${WALLET}&grouping=sector`,
    );
    expect(fromSearchParams(new URLSearchParams(query.slice(1)), 'asset_class')).toEqual(state);
  });
});

describe('encoding — only what is not already the default', () => {
  it('writes nothing for the default view', () => {
    expect(
      toQueryString(
        { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'asset_class' },
        'asset_class',
      ),
    ).toBe('');
  });

  it('writes the grouping only when it differs from the scope default', () => {
    // BR-011-04: the default is scope-dependent, so the same grouping is
    // explicit at one scope and implicit at the other.
    const state: ReportUrlState = {
      period: { kind: 'ytd' },
      scope: { kind: 'portfolio' },
      grouping: 'asset',
    };
    expect(toSearchParams(state, 'asset_class').get('grouping')).toBe('asset');
    expect(toSearchParams(state, 'asset').get('grouping')).toBeNull();
  });

  it('omits the custom dates for a non-custom period', () => {
    // Carrying from/to alongside period=ytd would put two contradictory
    // answers in one URL.
    const params = toSearchParams(
      { period: { kind: '12m' }, scope: { kind: 'portfolio' }, grouping: 'asset_class' },
      'asset_class',
    );
    expect(params.get('period')).toBe('12m');
    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
  });

  it('omits the wallet parameter at portfolio scope', () => {
    const params = toSearchParams(
      { period: { kind: 'ytd' }, scope: { kind: 'portfolio' }, grouping: 'wallet' },
      'asset_class',
    );
    expect(params.get('scope')).toBeNull();
    expect(params.get('wallet')).toBeNull();
    // Grouping BY wallet at portfolio scope is a normal view (BR-011-09), and
    // must not be confused with scoping TO a wallet.
    expect(params.get('grouping')).toBe('wallet');
  });
});

describe('parsing is total — a hand-edited URL never breaks the report', () => {
  it('defaults an absent query string to YTD / portfolio / the scope default', () => {
    expect(parse('')).toEqual({
      period: { kind: 'ytd' },
      scope: { kind: 'portfolio' },
      grouping: 'asset_class',
    });
  });

  it('falls back rather than mis-reading a near-miss value', () => {
    // The one thing parsing must never do is turn `sectr` into `sector`.
    expect(parse('grouping=sectr').grouping).toBe('asset_class');
    expect(parse('grouping=SECTOR').grouping).toBe('asset_class');
    expect(parse('period=36m').period).toEqual({ kind: 'ytd' });
    expect(parse('period=YTD').period).toEqual({ kind: 'ytd' });
  });

  it('uses the caller-supplied default grouping, which is scope-dependent', () => {
    expect(parse('', 'asset').grouping).toBe('asset');
    expect(parse('grouping=institution', 'asset').grouping).toBe('institution');
  });

  it('rejects a custom period whose dates are missing, partial or impossible', () => {
    expect(parse('period=custom').period).toEqual({ kind: 'ytd' });
    expect(parse('period=custom&from=2025-01-01').period).toEqual({ kind: 'ytd' });
    expect(parse('period=custom&to=2025-01-01').period).toEqual({ kind: 'ytd' });
    // 31 February is syntactically well-formed and does not exist. `Date`
    // would normalise it to 3 March; BusinessDate.of refuses it.
    expect(parse('period=custom&from=2025-02-31&to=2025-03-01').period).toEqual({ kind: 'ytd' });
    expect(parse('period=custom&from=garbage&to=2025-03-01').period).toEqual({ kind: 'ytd' });
    expect(parse('period=custom&from=2025-1-1&to=2025-03-01').period).toEqual({ kind: 'ytd' });
  });

  it('accepts a valid custom range, including a leap day', () => {
    expect(parse('period=custom&from=2024-02-29&to=2024-03-31').period).toEqual({
      kind: 'custom',
      from: '2024-02-29',
      to: '2024-03-31',
    });
  });

  it('falls back to portfolio scope when the wallet id is absent or not a UUID', () => {
    // Ids are interpolated into tenant-scoped comparisons (AR-11), so a value
    // that is not a UUID must never reach the query layer.
    expect(parse('scope=wallet').scope).toEqual({ kind: 'portfolio' });
    expect(parse('scope=wallet&wallet=').scope).toEqual({ kind: 'portfolio' });
    expect(parse('scope=wallet&wallet=1;DROP TABLE users').scope).toEqual({ kind: 'portfolio' });
    expect(parse('scope=wallet&wallet=not-a-uuid').scope).toEqual({ kind: 'portfolio' });
  });

  /**
   * BR-011-02 — **a wallet id is what makes a scope a wallet scope.**
   *
   * This assertion used to be the exact opposite, and that is what made the
   * scope control inert: `Controls.tsx` collapses "portfolio or which wallet"
   * into one `<select>`, because it is one question to a user even though it
   * was two values in the URL. Its comment stated the contract — "`scope=wallet`
   * is implied by a non-empty wallet id" — and the parser never implemented
   * it, so picking a wallet and pressing Aplicar reloaded the full portfolio.
   * Wallet scope was reachable only by hand-typing a URL.
   *
   * Two parameters that can contradict each other is the bug class, not just
   * the bug: `scope` is no longer written at all, so the id is the single
   * source of truth. Old bookmarks carrying `scope=wallet` still work — the
   * id beside it is what is read.
   */
  it('reads a wallet scope from the id alone, as the control submits it', () => {
    expect(parse(`wallet=${WALLET}`).scope).toEqual({ kind: 'wallet', walletId: WALLET });
  });

  it('reads a well-formed wallet scope, including a legacy scope=wallet bookmark', () => {
    expect(parse(`scope=wallet&wallet=${OTHER_WALLET}`).scope).toEqual({
      kind: 'wallet',
      walletId: OTHER_WALLET,
    });
    // A stale `scope=portfolio` beside a real id does not win: the id is the
    // answer, and this combination is no longer producible anyway.
    expect(parse(`scope=portfolio&wallet=${WALLET}`).scope).toEqual({
      kind: 'wallet',
      walletId: WALLET,
    });
  });

  it('an empty wallet selection is portfolio scope — what the control posts', () => {
    // The `<select>`'s portfolio option has `value=""`, so this is the exact
    // query string a user gets by choosing "Portfólio" and pressing Aplicar.
    expect(parse('wallet=').scope).toEqual({ kind: 'portfolio' });
  });

  it('accepts any object exposing get(name), not only URLSearchParams', () => {
    // Next's ReadonlyURLSearchParams and a plain test object both satisfy the
    // ReadableParams seam.
    const stub = { get: (name: string) => (name === 'grouping' ? 'wallet' : null) };
    expect(fromSearchParams(stub, 'asset_class').grouping).toBe('wallet');
  });
});
