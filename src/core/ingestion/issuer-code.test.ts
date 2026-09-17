import { describe, expect, it } from 'vitest';
import { issuerCodeOf } from '@/core/ingestion/issuer-code';

describe('#113 BR-008-29 — issuerCodeOf', () => {
  it.each([
    ['MGLU3', 'MGLU'],
    ['KLBN11', 'KLBN'],
    ['KLBN4', 'KLBN'],
    ['B3SA3', 'B3SA'],
    ['AAPL34', 'AAPL'],
    // The fractional market is the same shares on another book.
    ['MGLU3F', 'MGLU'],
    // Case and surrounding whitespace are not part of a ticker.
    [' mglu3 ', 'MGLU'],
  ])('%s → %s', (ticker, issuer) => {
    expect(issuerCodeOf(ticker)).toBe(issuer);
  });

  it.each([
    // A trailing letter other than F: unknown market, never guessed.
    'AXIA15G',
    // No issuer on B3's listed-companies data.
    'Tesouro IPCA+ 2029',
    'CDB6269CPH4',
    'CDB - BANCO EXEMPLO S/A',
    // Not a ticker shape: too short, no class, three-digit class, leading digit.
    'MGL3',
    'MGLU',
    'MGLU123',
    '1GLU3',
    '',
  ])('%s → null', (ticker) => {
    expect(issuerCodeOf(ticker)).toBeNull();
  });
});
