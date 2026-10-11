import { z } from 'zod';

/**
 * The wallet forms' input shapes (AR-32: Zod at the server-action boundary). They
 * live beside `actions.ts` rather than in it because a `'use server'` module may
 * export only async functions, and a schema is worth a unit test of its own.
 */

const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value));

/**
 * "Sem cor" (SPEC-010 BR-010-01): a native colour input always submits a value,
 * so "no colour" is its own checkbox, `noColor=on`. When it is on the colour is
 * ignored and stored as `null` — decided here, at the boundary, so it holds
 * without JavaScript too.
 */
export const noColorField = z.literal('on').optional();

export function withoutColorWhenNone<
  T extends { color: string | null; noColor?: 'on' | undefined },
>({ noColor, ...rest }: T): Omit<T, 'noColor'> {
  return { ...rest, color: noColor === 'on' ? null : rest.color } as Omit<T, 'noColor'>;
}

/**
 * `name` accepts the empty string on purpose (BR-022-21): the wallet's own rule
 * — a blank name is `INVALID_NAME` — is `createWallet`'s, and refusing it here
 * would turn it into a generic "verifique os dados" banner instead of the
 * message under the Nome field. The input keeps `required`, which is the
 * convenience; this is the enforcement, and it is the use case's.
 */
export const CreateWalletSchema = z
  .object({
    name: z.string(),
    description: optionalText,
    goal: optionalText,
    color: optionalText,
    noColor: noColorField,
  })
  .transform(withoutColorWhenNone);

export const UpdateWalletSchema = z
  .object({
    walletId: z.string(),
    // As on create: a blank name is refused by `updateWallet` with `INVALID_NAME`.
    name: z.string().optional(),
    description: optionalText,
    goal: optionalText,
    color: optionalText,
    noColor: noColorField,
  })
  .transform(withoutColorWhenNone);
