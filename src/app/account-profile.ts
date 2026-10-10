import { auth } from '@/auth';

/**
 * SPEC-022 BR-022-09 / SPEC-001 BR-001-05 — what the account menu and Conta
 * show about the person: the name, e-mail and picture **as Google supplied
 * them**, which are three of the four fields the product is allowed to store,
 * and nothing else.
 *
 * Read from the database session Auth.js resolves (the `users` row, via
 * `toAdapterUser` in `src/auth.ts`), never from a cookie or a form. `undefined`
 * for a visitor with no session. A session read that *fails* propagates, for
 * the reason `tryUserId()` gives (#42): "everyone is signed out" must not be
 * how a misconfiguration looks.
 */
export interface AccountProfile {
  readonly name: string | null;
  readonly email: string;
  readonly imageUrl: string | null;
}

export async function loadAccountProfile(): Promise<AccountProfile | undefined> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return undefined;

  return {
    name: user.name ?? null,
    email: user.email ?? '',
    imageUrl: user.image ?? null,
  };
}
