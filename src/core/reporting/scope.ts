import { domainError, type DomainError } from '@/core/shared/domain-error';
import type { WalletId } from '@/core/shared/ids';
import { err, ok, type Result } from '@/core/shared/result';
import {
  ReportingErrorCode,
  type ReportHolding,
  type ReportWallet,
  type Scope,
} from '@/core/reporting/ports';

/**
 * SPEC-011 BR-011-02 / AC-3 — scope narrows *what is included*: the whole
 * portfolio, or one wallet.
 *
 * **Scope is not grouping** (DL-011-01), and collapsing the two is the design
 * mistake this module exists to avoid. Scope answers "what is in the report";
 * grouping answers "how is it broken apart". They are independent, so
 * "this wallet, broken down by asset class" — a natural and common question —
 * is expressible. A single combined "view by" control cannot express it at
 * all.
 */

/**
 * BR-011-02 — the scope filter, applied to the canonical holding set.
 *
 * **Wallet scope uses ALLOCATED quantities, never full positions**, and this
 * is the rule most likely to be got quietly wrong. A user who splits 100 ITSA4
 * as 60 in "Aposentadoria" and 40 in "Renda" must see 60 in the first wallet
 * and 40 in the second. A report that scoped by "which assets does this wallet
 * touch" and then valued the *whole position* would show 100 in both — a
 * portfolio that appears to be 167% of itself, with two screens that each look
 * entirely reasonable in isolation (SPEC-010 BR-010-04, DL-010-01).
 *
 * The filter below is one line because `buildHoldingSet` has already done the
 * work: the holding set is sliced per `(asset, institution, wallet)`, so a
 * wallet's holdings are literally the slices carrying its id, and each already
 * holds that wallet's apportioned quantity, value and cost. There is nowhere
 * for a full position to leak in, because no slice ever holds one.
 *
 * The unallocated remainder (`walletId === null`) is excluded from wallet
 * scope, which is correct and is not a contradiction of BR-011-09: Unassigned
 * is a *group* that appears when grouping by wallet at **portfolio** scope, so
 * that allocated and unallocated always sum to the portfolio. It is not part
 * of any individual wallet — nothing in it has been filed there.
 */
export function applyScope(
  holdings: readonly ReportHolding[],
  scope: Scope,
): readonly ReportHolding[] {
  if (scope.kind === 'portfolio') return holdings;
  return holdings.filter((holding) => holding.walletId === scope.walletId);
}

/**
 * BR-011-02 — a scope naming a wallet this tenant does not have is refused,
 * not silently widened to the portfolio.
 *
 * The distinction matters more than it looks. A bookmarked URL (BR-011-11)
 * outlives the wallet it names: someone deletes "Renda", opens last month's
 * bookmark, and a scope that fell back to the portfolio would hand them their
 * **entire** *patrimônio* under a heading that says one wallet. Every figure
 * would be real, and every one of them would be answering a different question
 * from the one on screen.
 *
 * RLS makes the lookup a tenant-scoped read (AR-11), so another tenant's
 * wallet id is indistinguishable from a deleted one — both simply are not
 * found, which is the correct answer to give in both cases.
 */
export async function resolveScope(
  scope: Scope,
  findWallet: (walletId: WalletId) => Promise<ReportWallet | null>,
): Promise<Result<ResolvedScope, DomainError<ReportingErrorCode>>> {
  if (scope.kind === 'portfolio') return ok({ scope, wallet: null });

  const wallet = await findWallet(scope.walletId);
  if (wallet === null) {
    return err(domainError(ReportingErrorCode.WALLET_NOT_FOUND, { walletId: scope.walletId }));
  }
  return ok({ scope, wallet });
}

/**
 * A scope that has been checked against the tenant's own data.
 *
 * `wallet` is carried so the UI can title the report with the wallet's name
 * without a second lookup — and, more importantly, so it renders the name the
 * *scope actually resolved to* rather than one held in client state, which is
 * how a stale heading gets attached to fresh figures.
 */
export interface ResolvedScope {
  readonly scope: Scope;
  readonly wallet: ReportWallet | null;
}

/**
 * BR-011-16 / AC-14 — an empty scope is an explanatory empty state, never an
 * error and never a misleading zero.
 *
 * Exposed as a predicate rather than left to each report to re-derive, because
 * "is this empty" and "does this total zero" are different questions with the
 * same-looking answer. A wallet holding nothing and a wallet whose holdings are
 * currently worth nothing both render `R$ 0,00`; only the first one means
 * "there is nothing here yet", and only the second one means "this is what
 * your money is doing". Telling a user the second when the truth is the first
 * is exactly the misleading zero the rule forbids.
 */
export function isEmptyScope(holdings: readonly ReportHolding[]): boolean {
  return holdings.length === 0;
}
