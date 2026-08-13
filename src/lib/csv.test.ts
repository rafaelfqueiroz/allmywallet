import { describe, expect, it } from 'vitest';
import { neutralizeCsvCell, toCsv, toCsvField, toCsvRow } from './csv';

describe('neutralizeCsvCell (SPEC-003 BR-003-13)', () => {
  it.each([
    ['=cmd|"/c calc"!A1', '\'=cmd|"/c calc"!A1'],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
  ])('prefixes a cell starting with a formula trigger: %s', (input, expected) => {
    expect(neutralizeCsvCell(input)).toBe(expected);
  });

  it('leaves an ordinary cell untouched', () => {
    expect(neutralizeCsvCell('PETR4')).toBe('PETR4');
    expect(neutralizeCsvCell('Banco XP S.A.')).toBe('Banco XP S.A.');
  });

  it('does not neutralise a trigger character that is not in the leading position', () => {
    // BR-003-13 is specifically about the *cell* being interpreted as a
    // formula, which spreadsheets key off the leading character only.
    expect(neutralizeCsvCell('A=B')).toBe('A=B');
  });
});

describe('toCsvField', () => {
  it('quotes a field containing a comma, quote or newline (RFC 4180)', () => {
    expect(toCsvField('a,b')).toBe('"a,b"');
    expect(toCsvField('a"b')).toBe('"a""b"');
    expect(toCsvField('a\nb')).toBe('"a\nb"');
  });

  it('neutralises before quoting, so a dangerous quoted field stays inert', () => {
    // "opens inertly in Excel and LibreOffice" (SPEC-003 AC): the leading
    // apostrophe must survive being inside the quoted field, not get lost to
    // quoting order.
    expect(toCsvField('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('leaves a plain field unquoted', () => {
    expect(toCsvField('PETR4')).toBe('PETR4');
  });
});

describe('toCsvRow / toCsv', () => {
  it('joins fields with commas and rows with CRLF', () => {
    expect(toCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
    expect(
      toCsv([
        ['a', 'b'],
        ['=EVIL()', 'c'],
      ]),
    ).toBe("a,b\r\n'=EVIL(),c");
  });
});
