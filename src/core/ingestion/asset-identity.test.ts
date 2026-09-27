import { describe, expect, it } from 'vitest';
import { ASSET_ALIASES, canonicalAssetCode } from '@/core/ingestion/asset-identity';

describe('#135 SPEC-005 BR-005-14 — canonicalAssetCode', () => {
  it('resolves B3’s auction settlement ticker to the listed asset it settles', () => {
    expect(canonicalAssetCode('ENBR3L')).toBe('ENBR3');
  });

  it('ignores case and surrounding whitespace, as a Produto cell carries them', () => {
    expect(canonicalAssetCode('  enbr3l ')).toBe('ENBR3');
  });

  it('leaves the canonical code alone', () => {
    expect(canonicalAssetCode('ENBR3')).toBe('ENBR3');
  });

  /**
   * The whole point of a table over a suffix rule: `ENBR3L` is the listed code
   * with an `L` appended, and a rule reading it that way would silently take
   * any real ticker ending in `L` with it.
   */
  it.each(['ALOS3', 'KLBN11', 'PETR4', 'CDB6269CPH4', 'Tesouro IPCA+ 2029', 'AXIA15G'])(
    'returns %s unchanged — no suffix rule is inferred',
    (code) => {
      expect(canonicalAssetCode(code)).toBe(code);
    },
  );

  /**
   * #164: a Tesouro title resolves to the catalogue code `tesouro.sync`
   * prices, whichever way B3 spelled the product — the spelling of Educa+ and
   * Renda+ in a B3 extract has not been seen yet.
   */
  it.each([
    ['TESOURO SELIC 2029', 'Tesouro Selic 2029'],
    ['Tesouro Renda+ 2030', 'Tesouro Renda+ Aposentadoria Extra 2030'],
    ['Tesouro Educa+ 2026', 'Tesouro Educa+ 2026'],
  ])('#164: resolves the Tesouro title %s to %s', (code, canonical) => {
    expect(canonicalAssetCode(code)).toBe(canonical);
  });

  it('is total: an empty code is not an alias', () => {
    expect(canonicalAssetCode('')).toBe('');
  });

  it('never lists a canonical code as one of its own aliases', () => {
    for (const alias of ASSET_ALIASES) {
      expect(alias.codes).not.toContain(alias.canonicalCode);
      expect(alias.codes.length).toBeGreaterThan(0);
    }
  });

  it('never maps one code to two canonical codes', () => {
    const seen = ASSET_ALIASES.flatMap((alias) => alias.codes);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /** A canonical code that is itself an alias would make resolution order matter. */
  it('never makes a canonical code an alias of another', () => {
    const aliased = new Set(ASSET_ALIASES.flatMap((alias) => alias.codes));
    for (const alias of ASSET_ALIASES) expect(aliased.has(alias.canonicalCode)).toBe(false);
  });
});
