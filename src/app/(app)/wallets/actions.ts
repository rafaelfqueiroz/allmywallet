'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AssetId, WalletId } from '@/core/shared/ids';
import { Quantity } from '@/core/shared/money';
import { isErr } from '@/core/shared/result';
import { allocateToWallet } from '@/core/wallets/allocate';
import { createWallet } from '@/core/wallets/create-wallet';
import { deleteWallet } from '@/core/wallets/delete-wallet';
import { clearStandingRule, setStandingRule } from '@/core/wallets/standing-rule';
import { updateWallet } from '@/core/wallets/update-wallet';
import { withWalletDeps } from '@/app/(app)/wallets/composition';
import { requireUserId } from '@/lib/session';

/**
 * AR-32: each action validates input with Zod at the boundary (DV-07 — Zod is
 * the single source of truth; there is no separately hand-written type for
 * the same shape), resolves the session, and calls exactly one use case.
 *
 * Every action here is bound directly from a `<form action={...}>`, so each
 * returns `void` — React's form-action type has no room for a `Result`
 * (the same shape `(settings)/preferences/actions.ts` establishes). The use
 * cases themselves return `Result<T, DomainError>` (AR-34/AR-36) and are unit
 * tested without any of this boundary in `core/wallets/*.test.ts`; nothing
 * here is a place new business logic should ever land (AR-35).
 */

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value));

const CreateWalletSchema = z.object({
  name: z.string().min(1),
  description: optionalText,
  goal: optionalText,
  color: optionalText,
});

export async function createWalletAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = CreateWalletSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;

  const result = await withWalletDeps(userId, (deps) => createWallet(deps, userId, parsed.data));
  if (isErr(result)) return;
  revalidatePath('/wallets');
}

const UpdateWalletSchema = z.object({
  walletId: z.string(),
  name: z.string().min(1).optional(),
  description: optionalText,
  goal: optionalText,
  color: optionalText,
});

export async function updateWalletAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = UpdateWalletSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;
  const walletId = WalletId.of(parsed.data.walletId);

  const result = await withWalletDeps(userId, (deps) =>
    updateWallet(deps, userId, { ...parsed.data, walletId }),
  );
  if (isErr(result)) return;
  revalidatePath('/wallets');
  revalidatePath(`/wallets/${walletId}`);
}

const WalletIdSchema = z.object({ walletId: z.string() });

export async function deleteWalletAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = WalletIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;
  const walletId = WalletId.of(parsed.data.walletId);

  const result = await withWalletDeps(userId, (deps) => deleteWallet(deps, userId, walletId));
  if (isErr(result)) return;
  revalidatePath('/wallets');
}

/**
 * BR-010-03/BR-010-13: one action, quantity pre-filled with the full
 * unassigned amount by the form.
 *
 * Both forms bound to this action — the "Needs attention" queue on `/wallets`
 * and the post-import summary on `/import/[batchId]` — are *resolve a pending
 * item* forms, and the number they submit is the unassigned remainder. That
 * is `mode: 'add'`; see `allocate.ts` for why passing it as an absolute
 * target silently destroyed the chosen wallet's existing slice.
 */
const AllocateSchema = z.object({
  walletId: z.string(),
  assetId: z.string(),
  quantity: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value)),
});

export async function allocateAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = AllocateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;

  const result = await withWalletDeps(userId, (deps) =>
    parsed.data.quantity === undefined
      ? allocateToWallet(deps, userId, {
          walletId: WalletId.of(parsed.data.walletId),
          assetId: AssetId.of(parsed.data.assetId),
        })
      : allocateToWallet(deps, userId, {
          walletId: WalletId.of(parsed.data.walletId),
          assetId: AssetId.of(parsed.data.assetId),
          mode: 'add',
          quantity: Quantity.fromString(parsed.data.quantity),
        }),
  );
  if (isErr(result)) return;
  revalidatePath('/wallets');
  revalidatePath(`/wallets/${parsed.data.walletId}`);
}

const StandingRuleSchema = z.object({ assetId: z.string(), walletId: z.string() });

export async function setStandingRuleAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = StandingRuleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;

  const result = await withWalletDeps(userId, (deps) =>
    setStandingRule(
      deps,
      userId,
      AssetId.of(parsed.data.assetId),
      WalletId.of(parsed.data.walletId),
    ),
  );
  if (isErr(result)) return;
  revalidatePath('/wallets');
}

const AssetIdSchema = z.object({ assetId: z.string() });

export async function clearStandingRuleAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const parsed = AssetIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;

  await withWalletDeps(userId, (deps) =>
    clearStandingRule(deps, userId, AssetId.of(parsed.data.assetId)),
  );
  revalidatePath('/wallets');
}
