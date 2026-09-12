'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUserId } from '@/lib/session';
import { AssetId } from '@/core/shared/ids';
import { FIXED_INCOME_INDEXERS } from '@/core/valuation/ports';
import { normalizeDecimalInput } from '@/lib/decimal-input';
import { isErr } from '@/core/shared/result';
import { INVALID_INPUT, failure, type ActionState } from '@/lib/action-state';
import { supplyContractTermsFor } from '@/app/(app)/fixed-income/data';

/**
 * SPEC-020 BR-020-19 — the screen that resolves a missing fixed-income rate.
 * AR-32: Zod validates at the boundary (DV-07), identity comes from
 * `requireUserId()` (AR-12), and this calls exactly one use case
 * (`supplyContractTermsFor`, SPEC-009's own `supplyContractTerms` behind it).
 *
 * In the shape of `src/app/(app)/watch/actions.ts#createRuleAction`: a decimal
 * field is normalised with `normalizeDecimalInput` and handed to the use case
 * as a **string**, never a JS number (AR-06) — `SupplyContractTermsInput`'s
 * own contract is explicit that `ratePercent` crosses this boundary raw.
 */

const SupplyTermsSchema = z.object({
  assetId: z.string().min(1),
  indexer: z.enum(FIXED_INCOME_INDEXERS),
  ratePercent: z.string(),
});

export async function supplyContractTermsAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  const parsed = SupplyTermsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return INVALID_INPUT;

  const normalizedRate = normalizeDecimalInput(parsed.data.ratePercent);
  if (normalizedRate === null) return INVALID_INPUT;

  const assetId = AssetId.of(parsed.data.assetId);
  const result = await supplyContractTermsFor(userId, {
    assetId,
    indexer: parsed.data.indexer,
    ratePercent: normalizedRate,
  });
  if (isErr(result)) return failure(result.error);

  // BR-020-19's whole point is a portfolio value that stops being understated
  // once the rate is supplied — the dashboard is where that is seen.
  redirect('/dashboard');
}
