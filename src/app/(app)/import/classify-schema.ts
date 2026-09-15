import { z } from 'zod';
import { TRANSACTION_TYPES } from '@/core/ledger/transaction';
import { normalizeDecimalInput } from '@/lib/decimal-input';

/**
 * SPEC-005 BR-005-20 / SPEC-007 BR-007-04a — the classify form's input shape.
 *
 * Pulled out of `actions.ts` rather than declared inline: a `'use server'`
 * file may only export async functions (every other export is a build
 * error), so a schema that needs its own unit test — no database, no
 * `requireUserId` — has to live somewhere else. This module has no
 * `'use server'` directive and touches nothing but `zod` and pure parsing, so
 * `classify-schema.test.ts` exercises the real parsing code rather than a
 * mock of it (TS-02).
 *
 * **The ratio field only parses a decimal literal here.** Whether a ratio is
 * *required* (`split`/`grupamento`) or *not applicable* (every other type) is
 * `core/ledger/validate.ts`'s `validateRatio` — already covered by
 * `core/ledger/validate.test.ts` — so this schema does not re-encode that
 * business rule; duplicating it here would be a second place it could drift
 * from the first.
 */
export const optionalRatio = z
  .string()
  .optional()
  .transform((value, ctx) => {
    // Empty or absent is "no ratio supplied" (`null`) — never "zero". A value
    // present but not a pt-BR or canonical decimal literal (AR-06: parsed
    // with `normalizeDecimalInput`, never `Number`/`parseFloat`) is refused
    // at this boundary, distinct from "not supplied at all".
    if (value === undefined || value.trim() === '') return null;
    const normalized = normalizeDecimalInput(value);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a decimal literal' });
      return z.NEVER;
    }
    return normalized;
  });

export const ClassifySchema = z.object({
  rowId: z.string(),
  type: z.enum(TRANSACTION_TYPES),
  ratio: optionalRatio,
});
