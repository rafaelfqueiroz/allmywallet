import { describe, expect, it } from 'vitest';
import { classifyMovement, normalizeMovementType } from '@/core/ingestion/movement-map';

describe('SPEC-005 BR-005-18 — classifyMovement', () => {
  it('maps a known B3 string to the internal type', () => {
    expect(classifyMovement('Compra')).toBe('buy');
    expect(classifyMovement('Venda')).toBe('sell');
    expect(classifyMovement('Dividendo')).toBe('dividend');
    expect(classifyMovement('Juros Sobre Capital Próprio')).toBe('jcp');
    expect(classifyMovement('Rendimento')).toBe('rendimento');
    expect(classifyMovement('Amortização')).toBe('amortization');
    expect(classifyMovement('Bonificação em Ativos')).toBe('bonificacao');
    expect(classifyMovement('Direitos de Subscrição - Exercido')).toBe('subscription');
  });

  it('is case, accent and whitespace insensitive', () => {
    expect(classifyMovement('  COMPRA  ')).toBe('buy');
    expect(classifyMovement('venda')).toBe('sell');
    expect(classifyMovement('juros   sobre capital proprio')).toBe('jcp');
    expect(classifyMovement('AMORTIZACAO')).toBe('amortization');
  });

  it('disambiguates a direction-dependent string by the Entrada/Saída column', () => {
    expect(classifyMovement('Transferência', 'credit')).toBe('transfer_in');
    expect(classifyMovement('Transferência', 'debit')).toBe('transfer_out');
  });

  /**
   * SPEC-005 BR-005-01 — Negociação is "the authoritative trade record", and
   * trades are not among the roles the spec gives Movimentação.
   *
   * `Transferência - Liquidação` is a trade settling, not a custody transfer.
   * While it mapped to `transfer_in`, which `apply-transaction.ts` treats as
   * an acquisition, a user following the onboarding guide — which asks for
   * all three extracts — imported every purchase twice, under two different
   * movement types and two different institutions, so the natural key never
   * matched and *patrimônio* silently doubled.
   *
   * Unmapped, not dropped: BR-005-19 still stores the row and surfaces it in
   * Needs attention, so a Movimentação-only user can classify it themselves.
   */
  it('BR-005-01: a trade settlement in Movimentação is not a transfer', () => {
    expect(classifyMovement('Transferência - Liquidação', 'credit')).toBeNull();
    expect(classifyMovement('Transferência - Liquidação', 'debit')).toBeNull();
  });

  it('falls back to the first candidate when no direction is supplied', () => {
    expect(classifyMovement('Transferência')).toBe('transfer_in');
  });

  it('BR-005-19: an unrecognised type returns null rather than a guess', () => {
    expect(classifyMovement('Um Tipo Que a B3 Inventou Ontem')).toBeNull();
  });

  it('BR-005-18: split/grupamento are deliberately unmapped — a Movimentação row cannot supply the BR-007-04 ratio', () => {
    expect(classifyMovement('Desdobro')).toBeNull();
    expect(classifyMovement('Grupamento')).toBeNull();
  });

  it('normalizeMovementType folds case, accents and whitespace', () => {
    expect(normalizeMovementType('  Ação   Ordinária ')).toBe('acao ordinaria');
  });
});
