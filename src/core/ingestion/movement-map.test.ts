import { describe, expect, it } from 'vitest';
import {
  classifyMovement,
  conversionEvidenceMovementOf,
  corporateEventMovementOf,
  isIgnoredMovement,
  MOVEMENT_MAP_VERSION,
  normalizeMovementType,
} from '@/core/ingestion/movement-map';

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

  it('#110 (v3): Tesouro and bank-paper applications, redemptions and capital returns', () => {
    expect(classifyMovement('APLICAÇÃO', 'credit')).toBe('buy');
    expect(classifyMovement('Resgate', 'credit')).toBe('sell');
    expect(classifyMovement('RESGATE ANTECIPADO/', 'debit')).toBe('sell');
    expect(classifyMovement('Restituição de Capital', 'credit')).toBe('amortization');
    expect(classifyMovement('Restituição de Capital em Ações', 'credit')).toBeNull();
  });

  it('BR-005-19 (amended, #110): mirrors of another extract are ignored in either direction', () => {
    for (const type of [
      'Transferência - Liquidação',
      'Juros Sobre Capital Próprio - Transferido',
      'DIVIDENDO - TRANSFERIDO',
    ]) {
      expect(isIgnoredMovement(type)).toBe(true);
    }
    expect(isIgnoredMovement('Transferência')).toBe(false);
    expect(isIgnoredMovement('Juros Sobre Capital Próprio - Reativado')).toBe(false);
  });

  it('normalizeMovementType folds case, accents and whitespace', () => {
    expect(normalizeMovementType('  Ação   Ordinária ')).toBe('acao ordinaria');
  });
});

describe('SPEC-005 BR-005-18 v5 — corporate-event and conversion rows are named, not mapped', () => {
  it('is version 5', () => {
    expect(MOVEMENT_MAP_VERSION).toBe(5);
  });

  it('names the four rows BR-005-20b resolves at commit, whatever the casing', () => {
    expect(corporateEventMovementOf('Desdobro')).toBe('desdobro');
    expect(corporateEventMovementOf('GRUPAMENTO')).toBe('grupamento');
    expect(corporateEventMovementOf('Fração em Ativos')).toBe('fracao_em_ativos');
    expect(corporateEventMovementOf(' Leilão de  Fração ')).toBe('leilao_de_fracao');
  });

  it('leaves them unmapped, so they stage under the key v3 stored them with (BR-005-17)', () => {
    for (const type of ['Desdobro', 'Grupamento', 'Fração em Ativos', 'Leilão de Fração']) {
      expect(classifyMovement(type, 'credit')).toBeNull();
      expect(classifyMovement(type, 'debit')).toBeNull();
      expect(isIgnoredMovement(type)).toBe(false);
    }
  });

  it('does not name the conversions left to #121, nor an inherited prototype key', () => {
    for (const type of [
      'Atualização',
      'Resgate',
      'Incorporação',
      'Bonificação em Ativos',
      'constructor',
    ]) {
      expect(corporateEventMovementOf(type)).toBeNull();
    }
  });
});

describe('SPEC-005 BR-005-18 v5 — asset-conversion evidence', () => {
  const listedWithoutPrice = { assetClass: 'stock' as const, priceStated: false };

  it('names Atualização and Incorporação without mapping them', () => {
    expect(conversionEvidenceMovementOf(' Atualização ', listedWithoutPrice)).toBe('atualizacao');
    expect(conversionEvidenceMovementOf('INCORPORACAO', listedWithoutPrice)).toBe('incorporacao');
    expect(classifyMovement('Atualização')).toBeNull();
    expect(classifyMovement('Incorporação')).toBeNull();
  });

  it('names only a price-less listed Resgate as conversion evidence', () => {
    expect(conversionEvidenceMovementOf('Resgate', listedWithoutPrice)).toBe('resgate');
    expect(
      conversionEvidenceMovementOf('Resgate', { assetClass: 'stock', priceStated: true }),
    ).toBeNull();
  });

  it('keeps ordinary FII and bank-paper Resgate as a sell', () => {
    for (const assetClass of ['fii', 'tesouro_direto', 'cdb', 'lci', 'lca'] as const) {
      expect(
        conversionEvidenceMovementOf('Resgate', { assetClass, priceStated: false }),
      ).toBeNull();
      expect(classifyMovement('Resgate')).toBe('sell');
    }
  });
});
