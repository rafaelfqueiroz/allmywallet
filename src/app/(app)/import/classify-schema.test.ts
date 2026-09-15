import { describe, expect, it } from 'vitest';
import { ClassifySchema } from '@/app/(app)/import/classify-schema';

/**
 * SPEC-007 BR-007-04a / #113 — the classify form's ratio field.
 *
 * Pure `zod` parsing, no database: this is the boundary AR-06 exists to
 * guard, so it is proven here rather than only through
 * `core/ledger/validate.test.ts`, which starts from an already-parsed
 * `Quantity` and never sees the pt-BR string a user actually typed.
 */
describe('ClassifySchema — ratio parsing (#113)', () => {
  const base = { rowId: 'row-1', type: 'split' as const };

  it('reads a pt-BR decimal literal', () => {
    const parsed = ClassifySchema.safeParse({ ...base, ratio: '0,1' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ratio).toBe('0.1');
  });

  it('reads a canonical integer literal', () => {
    const parsed = ClassifySchema.safeParse({ ...base, ratio: '10' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ratio).toBe('10');
  });

  it('refuses a value that is not a decimal literal at all', () => {
    const parsed = ClassifySchema.safeParse({ ...base, ratio: 'abc' });
    expect(parsed.success).toBe(false);
  });

  it('reads an absent ratio as "not supplied" rather than an error', () => {
    const parsed = ClassifySchema.safeParse({ rowId: 'row-1', type: 'buy' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ratio).toBeNull();
  });

  it('reads an empty-string ratio the same way as an absent one', () => {
    const parsed = ClassifySchema.safeParse({ ...base, ratio: '' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ratio).toBeNull();
  });

  /**
   * The schema parses *format* only — whether a ratio is required for
   * `split`/`grupamento` and refused for every other type is
   * `core/ledger/validate.ts`'s `validateRatio` (`RATIO_REQUIRED`,
   * `RATIO_NOT_APPLICABLE`), already covered by `validate.test.ts`. A row
   * classified as, say, `dividend` with no ratio typed is exactly this case:
   * the field parses to `null` here, and the core is what accepts or refuses
   * it once it knows the chosen type.
   */
  it('parses the same way regardless of the chosen type — the type/ratio rule is the core’s, not the schema’s', () => {
    const withoutRatio = ClassifySchema.safeParse({ rowId: 'row-1', type: 'dividend' });
    expect(withoutRatio.success).toBe(true);
    if (withoutRatio.success) expect(withoutRatio.data.ratio).toBeNull();
  });

  it('accepts every SPEC-006 transaction type, including the two #113 added', () => {
    for (const type of ['leilao_fracoes', 'fracao_bonificacao']) {
      const parsed = ClassifySchema.safeParse({ rowId: 'row-1', type });
      expect(parsed.success).toBe(true);
    }
  });
});
