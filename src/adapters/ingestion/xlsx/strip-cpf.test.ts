import { describe, expect, it } from 'vitest';
import { isValidCpf, sanitizeRow, stripCpf } from '@/adapters/ingestion/xlsx/strip-cpf';

// A checksum-valid CPF used throughout Brazilian QA fixtures/documentation —
// not a real person's document (TS-19/TS-20: synthetic, generated data).
const VALID_CPF = '11144477735';

describe('SPEC-005 BR-005-07 / SPEC-004 BR-004-02 — isValidCpf', () => {
  it('accepts a checksum-valid CPF', () => {
    expect(isValidCpf(VALID_CPF)).toBe(true);
  });

  it('rejects a bad checksum', () => {
    expect(isValidCpf('11144477736')).toBe(false);
  });

  it('rejects the all-repeated-digit sequences a naive checksum would accept', () => {
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('00000000000')).toBe(false);
  });

  it('rejects anything not exactly 11 digits', () => {
    expect(isValidCpf('123')).toBe(false);
    expect(isValidCpf('123456789012')).toBe(false);
  });
});

describe('stripCpf', () => {
  it('redacts a formatted CPF', () => {
    expect(stripCpf('Titular: João Silva CPF: 111.444.777-35')).toBe(
      'Titular: João Silva CPF: [CPF removido]',
    );
  });

  it('redacts a bare, checksum-valid CPF', () => {
    expect(stripCpf(`conta ${VALID_CPF} ativa`)).toBe('conta [CPF removido] ativa');
  });

  it('never touches an 11-digit sequence that fails the checksum — false positives corrupt real data', () => {
    const quantity = '12345678901'; // 11 digits, not a valid CPF
    expect(stripCpf(quantity)).toBe(quantity);
  });

  it('leaves ordinary cell content untouched', () => {
    expect(stripCpf('PETR4')).toBe('PETR4');
    expect(stripCpf('100')).toBe('100');
  });

  it('sanitizeRow strips every cell, not only the ones expected to carry a CPF', () => {
    const row = { Produto: 'PETR4', Titular: `CPF ${VALID_CPF}`, Quantidade: '100' };
    const sanitized = sanitizeRow(row);
    expect(sanitized['Titular']).toBe('CPF [CPF removido]');
    expect(sanitized['Produto']).toBe('PETR4');
    expect(sanitized['Quantidade']).toBe('100');
  });
});
