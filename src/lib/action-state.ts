import type { DomainError, ErrorContextValue } from '@/core/shared/domain-error';
import { SharedErrorCode } from '@/core/shared/domain-error';

/**
 * What a mutating server action returns to its form.
 *
 * Shared by `(app)/transactions` and `(app)/import`, which is why it sits in
 * `lib/` rather than beside either — the second surface to need it would
 * otherwise have imported the first's internals.
 *
 * **The wallets actions return `void` and swallow their errors** — `if
 * (isErr(result)) return;` — which is survivable there because every one of
 * them is an "assign the whole thing" click with nothing to explain. It is not
 * survivable here: BR-006-15 is explicit that an impossible state is refused
 * "with an explanation of why, **not a silent rejection**", and the headline
 * case is a sale of more than was held, whose message names the held quantity.
 * A form that silently redisplays itself after refusing a sale is precisely
 * the failure that rule forbids.
 *
 * So the state carries the domain's **code and context** (AR-37), never a
 * formatted string — `useActionState` in the form component renders it through
 * the `errors.*` catalogue (AR-38), exactly as the page already renders
 * `listTransactions`' failure.
 *
 * AR-10: this crosses the server-action JSON boundary, so every context value
 * is a primitive. `Money` and `Quantity` are already stringified by the
 * domain (`errors.ts` restricts the context type to primitives for this
 * reason) — nothing here may ever hold a `Decimal`, which `JSON.stringify`
 * would turn into a float.
 */
/**
 * The two bulk operations report what they did rather than redirecting.
 *
 * BR-006-17's assignment is the reason: `assignTransactionsToWallet` returns a
 * `skipped` list — an asset already fully allocated elsewhere, or one whose
 * selection nets to nothing — and clamping to the unassigned remainder is only
 * honest if the shortfall is *said*. Discarding that list would make the
 * clamp silent, which is the thing the use case's own comment refuses.
 *
 * It also gives both operations a post-condition. Redirecting to the page the
 * form is already on changes nothing observable, so nothing could tell "the
 * action finished" from "the action was never dispatched" — including a test.
 */
export type ActionState =
  | { readonly status: 'idle' }
  | { readonly status: 'assigned'; readonly assigned: number; readonly skipped: number }
  | { readonly status: 'deleted'; readonly deleted: number }
  | {
      readonly status: 'error';
      readonly code: string;
      readonly context: Readonly<Record<string, ErrorContextValue>>;
    };

export const IDLE: ActionState = { status: 'idle' };

export function failure(error: DomainError): ActionState {
  return { status: 'error', code: error.code, context: error.context };
}

/**
 * A Zod refusal at the boundary (AR-32). Deliberately the generic code rather
 * than a field-by-field report: the schemas here only reject shapes the form's
 * own `required`/`type` attributes already prevent, so reaching this means
 * something bypassed the form, and the domain's own validation
 * (`core/ledger/validate.ts`) is what produces the messages a user acts on.
 */
export const INVALID_INPUT: ActionState = {
  status: 'error',
  code: SharedErrorCode.VALIDATION_FAILED,
  context: {},
};

/**
 * `next-intl` interpolates `string | number | Date`; a domain context may also
 * hold `boolean` and `null` (AR-37's primitive-only rule is wider than what a
 * message can render). Narrowing here rather than at each call site keeps the
 * two components that render an `ActionState` reading the same way — and a
 * `null` renders as an empty span rather than the literal text `null`.
 */
export function messageValues(
  context: Readonly<Record<string, ErrorContextValue>>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      value === null ? '' : typeof value === 'number' ? value : String(value),
    ]),
  );
}
