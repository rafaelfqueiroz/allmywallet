import type { DomainError } from '@/core/shared/domain-error';
import { WalletId, type UserId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { Wallet } from '@/core/wallets/wallet';

/** SPEC-010 BR-010-01/BR-010-02: create, with an optional description, goal and colour. */
export interface CreateWalletInput {
  readonly name: string;
  readonly description?: string | null | undefined;
  /** BR-010-02: descriptive only, never used in a calculation. */
  readonly goal?: string | null | undefined;
  readonly color?: string | null | undefined;
}

export async function createWallet(
  deps: WalletDependencies,
  userId: UserId,
  input: CreateWalletInput,
): Promise<Result<Wallet, DomainError>> {
  const name = input.name.trim();
  if (name.length === 0) return err(walletError(WalletErrorCode.INVALID_NAME));

  const now = deps.clock.now();
  const wallet: Wallet = {
    id: WalletId.generate(),
    userId,
    name,
    description: normalizeText(input.description),
    goal: normalizeText(input.goal),
    color: normalizeText(input.color),
    // SPEC-017 BR-017-01: targets are opt-in. A new wallet declares none, and
    // behaves exactly as wallets did before the feature existed.
    targetMode: 'none',
    createdAt: now,
    updatedAt: now,
  };

  await deps.wallets.insert(wallet);
  return ok(wallet);
}

/** Shared with `update-wallet.ts` — blank optional text normalises to `null`, never an empty string. */
export function normalizeText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
