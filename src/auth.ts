import NextAuth, { type DefaultSession } from 'next-auth';
import Google from 'next-auth/providers/google';
import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { accounts, sessions, users } from '@/db/schema/users';
import { DrizzleUserRepository } from '@/adapters/db/user-repository';
import { provisionTenant } from '@/core/identity/provision-tenant';
import { UserId } from '@/core/shared/ids';
import { env } from '@/lib/env';

/**
 * `session.user.id` is what `requireUserId()` (src/lib/session.ts) reads —
 * Auth.js's default `Session` type does not carry it (see `callbacks.session`
 * below for why it must be added explicitly).
 */
declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

/**
 * SPEC-002 (#5, `feat/spec-002-configuration-layer`) is being built in
 * parallel on a different branch and does not exist here yet. Once it lands,
 * this becomes a call into `@/config/resolve` for the `auth.session_idle_days`
 * key (default 30, per DL-001-04) instead of a hardcoded constant.
 * TODO(#5): read auth.session_idle_days from the config registry.
 */
function getSessionIdleDays(): number {
  return 30;
}

const userRepository = new DrizzleUserRepository(db);

function toAdapterUser(user: {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
}): AdapterUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.imageUrl,
    // BR-001-05: no email-verification bookkeeping is stored — Google itself
    // is the verifier, and this product has no Email-provider flow that
    // would ever read this field back. Always `null`, never persisted.
    emailVerified: null,
  };
}

/**
 * A hand-rolled `Adapter` rather than `@auth/drizzle-adapter`'s generic
 * `PostgresDrizzleAdapter` factory. Two reasons, both load-bearing (not a
 * style preference — see the #4/#6 report's Decision log):
 *
 * 1. The generic factory's `usersTable` type requires an `emailVerified`
 *    timestamp column (`DefaultPostgresUsersTable`). BR-001-05 limits stored
 *    personal data to Google subject id, email, display name and picture URL
 *    — "nothing else" — and this product never uses the Email provider that
 *    column exists for.
 * 2. `google_subject_id NOT NULL UNIQUE` (BR-001-03/DL-001-02 — the actual
 *    identity key) can only be populated atomically at row-creation time if
 *    `createUser` can see it. The generic factory's `createUser(data:
 *    AdapterUser)` receives only `{ id, name, email, image }` with no access
 *    to the OAuth account being linked. Our `createUser` below *can* see it,
 *    because NextAuth's default OAuth profile normalisation maps
 *    `profile.sub` into `AdapterUser.id` before `createUser` is ever called
 *    (`next-auth/providers/google` defines no `profile()` override, so the
 *    library default in `@auth/core/lib/utils/providers.js` —
 *    `id: profile.sub ?? profile.id ?? crypto.randomUUID()` — applies).
 *    `data.id` here *is* the Google subject id.
 *
 * User creation is delegated to `provisionTenant`/`UserRepository`
 * (core/identity), whose `INSERT ... ON CONFLICT (google_subject_id) DO
 * UPDATE` is what actually makes BR-001-04's idempotency guarantee atomic
 * under a race. Auth.js's own sign-in flow (`getUserByAccount` →
 * `createUser` → `linkAccount`) is a JS-level check-then-act with no such
 * guarantee by itself — two concurrent callbacks for the same brand-new
 * Google account could both observe "no existing account" and both reach
 * `createUser`; the database-level `ON CONFLICT`, not the JS flow, is what
 * guarantees only one `users` row ever exists for that subject.
 */
function buildAuthAdapter(): Adapter {
  return {
    async createUser(data: AdapterUser) {
      const user = await provisionTenant(userRepository, {
        googleSubjectId: data.id,
        email: data.email,
        name: data.name ?? null,
        imageUrl: data.image ?? null,
      });
      return toAdapterUser(user);
    },

    async getUser(id) {
      const user = await userRepository.findById(UserId.of(id));
      return user ? toAdapterUser(user) : null;
    },

    async getUserByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email));
      return row ? toAdapterUser(row) : null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const [row] = await db
        .select({ user: users })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(
          and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)),
        );
      return row ? toAdapterUser(row.user) : null;
    },

    async updateUser(data) {
      if (!data.id) throw new Error('auth adapter: updateUser requires an id');
      const [row] = await db
        .update(users)
        .set({
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.image !== undefined ? { imageUrl: data.image } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, data.id))
        .returning();
      if (!row) throw new Error('auth adapter: updateUser found no matching user');
      return toAdapterUser(row);
    },

    // BR-001-09: the deletion mechanics themselves (review window, purge,
    // backup-cycle expiry) are SPEC-004 (#7). This is a low-level primitive —
    // AR-27's ON DELETE CASCADE is what actually cleans up everything that
    // references this row.
    async deleteUser(id) {
      await db.delete(users).where(eq(users.id, id));
    },

    async linkAccount(account: AdapterAccount) {
      await db.insert(accounts).values({
        userId: account.userId,
        type: account.type,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        ...(account.refresh_token !== undefined ? { refreshToken: account.refresh_token } : {}),
        ...(account.access_token !== undefined ? { accessToken: account.access_token } : {}),
        ...(account.expires_at !== undefined
          ? { accessTokenExpiresAt: new Date(account.expires_at * 1000) }
          : {}),
        ...(account.token_type !== undefined ? { tokenType: account.token_type } : {}),
        ...(account.scope !== undefined ? { scope: account.scope } : {}),
        ...(account.id_token !== undefined ? { idToken: account.id_token } : {}),
      });
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await db
        .delete(accounts)
        .where(
          and(eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)),
        );
    },

    async createSession(session) {
      const [row] = await db.insert(sessions).values(session).returning();
      if (!row) throw new Error('auth adapter: createSession returned no row');
      return row;
    },

    async getSessionAndUser(sessionToken) {
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.sessionToken, sessionToken));
      if (!row) return null;
      return { session: row.session, user: toAdapterUser(row.user) };
    },

    async updateSession(session) {
      const [row] = await db
        .update(sessions)
        .set({
          ...(session.expires !== undefined ? { expires: session.expires } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sessions.sessionToken, session.sessionToken))
        .returning();
      return row ?? null;
    },

    // SPEC-001 BR-001-07: sign-out invalidates the session server-side.
    // Clearing the cookie client-side is not sufficient — this is what
    // actually removes the row, so replaying a captured session cookie
    // afterwards finds nothing to resume.
    async deleteSession(sessionToken) {
      await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
    },
  };
}

/**
 * AR-40/AR-41: an invalid or incomplete environment fails startup rather
 * than falling back silently — checked narrowly here (not in `src/lib/env.ts`,
 * which every process imports, including the worker, which never touches
 * auth) so a missing credential surfaces as an immediate boot failure with a
 * specific message, not a broken sign-in page discovered only when a user
 * tries it. `env.ts` keeps these three fields optional for exactly that
 * reason — this is where "required" is actually enforced.
 */
function requireAuthEnv(): { authSecret: string; googleId: string; googleSecret: string } {
  const e = env();
  if (!e.AUTH_SECRET) {
    throw new Error(
      'AUTH_SECRET is required (DEVELOPMENT.md §5: fill in Google OAuth credentials).',
    );
  }
  if (!e.AUTH_GOOGLE_ID) {
    throw new Error(
      'AUTH_GOOGLE_ID is required (DEVELOPMENT.md §5: fill in Google OAuth credentials).',
    );
  }
  if (!e.AUTH_GOOGLE_SECRET) {
    throw new Error(
      'AUTH_GOOGLE_SECRET is required (DEVELOPMENT.md §5: fill in Google OAuth credentials).',
    );
  }
  return {
    authSecret: e.AUTH_SECRET,
    googleId: e.AUTH_GOOGLE_ID,
    googleSecret: e.AUTH_GOOGLE_SECRET,
  };
}

const authEnv = requireAuthEnv();

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: buildAuthAdapter(),
  // BR-001-06/BR-001-07: database sessions, not JWT — a stateless JWT cannot
  // be revoked before its own expiry, and BR-001-07 requires sign-out to
  // invalidate server-side. The per-request session lookup this costs is
  // accepted (ARCHITECTURE §8's rationale for the split applies here too).
  session: {
    strategy: 'database',
    maxAge: getSessionIdleDays() * 24 * 60 * 60,
    // How often an active session's expiry is pushed forward. Daily is
    // frequent enough that "idle" tracks real inactivity rather than the
    // session's original sign-in time, without writing to `sessions` on
    // every request.
    updateAge: 24 * 60 * 60,
  },
  providers: [
    Google({
      clientId: authEnv.googleId,
      clientSecret: authEnv.googleSecret,
      // SPEC-001 BR-001-02: only these three scopes, ever. Widening this
      // requires a documented privacy review, not just a code change.
      authorization: { params: { scope: 'openid email profile' } },
    }),
  ],
  secret: authEnv.authSecret,
  callbacks: {
    // The default `session` callback (see @auth/core/lib/init.js) strips the
    // database user down to name/email/image — no `id`. `requireUserId()`
    // (src/lib/session.ts) needs the id on every request, so it is restored
    // here explicitly rather than relying on the default.
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  pages: {
    // BR-001-12: the account-recovery limitation is disclosed on this page,
    // not buried in terms (src/app/(auth)/signin/page.tsx).
    signIn: '/signin',
  },
});
