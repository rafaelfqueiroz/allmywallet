import type { DomainError } from '@/core/shared/domain-error';
import type { UserId, WalletId } from '@/core/shared/ids';
import { type Result, err, ok } from '@/core/shared/result';
import { normalizeText } from '@/core/wallets/create-wallet';
import type { WalletDependencies } from '@/core/wallets/dependencies';
import { WalletErrorCode, walletError } from '@/core/wallets/errors';
import type { Wallet } from '@/core/wallets/wallet';

/** SPEC-010 BR-010-01: rename, describe and colour an existing wallet. */
export interface UpdateWalletInput {
  readonly walletId: WalletId;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly goal?: string | null | undefined;
  readonly color?: string | null | undefined;
}

export async function updateWallet(
  deps: WalletDependencies,
  userId: UserId,
  input: UpdateWalletInput,
): Promise<Result<Wallet, DomainError>> {
  const existing = await deps.wallets.findById(input.walletId);
  if (existing === null || existing.userId !== userId) {
    return err(walletError(WalletErrorCode.WALLET_NOT_FOUND, { walletId: input.walletId }));
  }

  let name = existing.name;
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length === 0) return err(walletError(WalletErrorCode.INVALID_NAME));
    name = trimmed;
  }

  const updated: Wallet = {
    ...existing,
    name,
    description:
      input.description !== undefined ? normalizeText(input.description) : existing.description,
    goal: input.goal !== undefined ? normalizeText(input.goal) : existing.goal,
    color: input.color !== undefined ? normalizeText(input.color) : existing.color,
    updatedAt: deps.clock.now(),
  };

  await deps.wallets.update(updated);
  return ok(updated);
}
