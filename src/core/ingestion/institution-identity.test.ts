import { describe, expect, it } from 'vitest';
import {
  INSTITUTION_ALIASES,
  canonicalInstitutionName,
  institutionIdentityKey,
  normalizeInstitutionName,
} from '@/core/ingestion/institution-identity';

/**
 * SPEC-005 BR-005-14 / SPEC-007 BR-007-08 (#136).
 *
 * The negative cases carry as much of this file as the positive ones: the
 * failure this rule guards against is not a missed merge, it is a merge of two
 * institutions that are genuinely different.
 */
describe('institution identity (#136)', () => {
  const sameInstitution = (a: string, b: string) =>
    institutionIdentityKey(a) === institutionIdentityKey(b);

  describe('normalizeInstitutionName', () => {
    it('ignores case, accents, punctuation and repeated whitespace', () => {
      expect(normalizeInstitutionName('  Corretora  Exemplo,  S/A ')).toBe('CORRETORA EXEMPLO S A');
      expect(normalizeInstitutionName('TÍTULOS E VALORES')).toBe('TITULOS E VALORES');
    });

    it('keeps the legal-form suffix, which is what tells two brokers of one group apart', () => {
      expect(normalizeInstitutionName('BANCO INTER S/A')).toContain('BANCO');
      expect(normalizeInstitutionName('INTER DTVM LTDA')).toContain('DTVM');
    });
  });

  describe('the spellings B3 wrote for the owner’s four brokers', () => {
    it('reads Inter’s expansion and its acronym as one institution', () => {
      expect(
        sameInstitution(
          'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
          'INTER DTVM LTDA',
        ),
      ).toBe(true);
    });

    it('reads XP’s three spellings as one institution', () => {
      const full = 'XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A';
      expect(sameInstitution(full, 'XP INVESTIMENTOS CCTVM S/A')).toBe(true);
      expect(
        sameInstitution(full, 'XP INVESTIMENTOS CORRETORA DE CAMBIO, TITULOS E VALORES MOBI'),
      ).toBe(true);
    });

    it('keeps Clear apart from XP — one group, two brokers, two custody locations', () => {
      expect(sameInstitution('CLEAR CORRETORA - GRUPO XP', 'XP INVESTIMENTOS CCTVM S/A')).toBe(
        false,
      );
    });

    it('keeps Banco Inter apart from Inter DTVM — the issuer is not the custodian', () => {
      expect(sameInstitution('BANCO INTER S/A', 'INTER DTVM LTDA')).toBe(false);
      expect(
        sameInstitution(
          'BANCO INTER S/A',
          'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
        ),
      ).toBe(false);
    });

    it('keeps two brokers sharing a legal form apart', () => {
      expect(sameInstitution('RICO INVESTIMENTOS CCTVM S/A', 'XP INVESTIMENTOS CCTVM S/A')).toBe(
        false,
      );
    });
  });

  describe('canonicalInstitutionName', () => {
    it('replaces every known spelling with the alias table’s canonical one', () => {
      for (const alias of INSTITUTION_ALIASES) {
        for (const spelling of [alias.canonicalName, ...alias.spellings]) {
          expect(canonicalInstitutionName(spelling)).toBe(alias.canonicalName);
        }
      }
    });

    it('matches a known spelling however it is cased, accented or punctuated', () => {
      expect(canonicalInstitutionName('  inter   dtvm,  ltda ')).toBe(
        'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
      );
    });

    it('keeps the extract’s own text for a name the table does not know', () => {
      expect(canonicalInstitutionName('  CLEAR   CORRETORA - GRUPO XP  ')).toBe(
        'CLEAR CORRETORA - GRUPO XP',
      );
    });

    it('is idempotent — canonicalising a canonical name changes nothing', () => {
      for (const alias of INSTITUTION_ALIASES) {
        expect(canonicalInstitutionName(alias.canonicalName)).toBe(alias.canonicalName);
      }
    });
  });

  it('names no spelling under two canonical institutions', () => {
    const seen = new Map<string, string>();
    for (const alias of INSTITUTION_ALIASES) {
      for (const spelling of [alias.canonicalName, ...alias.spellings]) {
        const key = normalizeInstitutionName(spelling);
        expect(seen.get(key) ?? alias.canonicalName).toBe(alias.canonicalName);
        seen.set(key, alias.canonicalName);
      }
    }
  });
});
