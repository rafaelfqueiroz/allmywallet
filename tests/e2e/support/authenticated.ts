import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test as base, type BrowserContext, type Page } from '@playwright/test';

/**
 * An authenticated browser context for the E2E suite.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SEEDS A SESSION ROW RATHER THAN DRIVING A LOGIN
 *
 * SPEC-001 BR-001-01 makes Google the only identity provider, ever. Driving a
 * real Google sign-in from CI would need a Google account and its password
 * living in the repository's secrets and being typed into a browser by a test
 * — which is exactly the thing SPEC-003 BR-003-08 forbids the product from
 * doing, and TS-26 forbids the suite from depending on. So the flow that
 * *cannot* be tested here is the OAuth handshake itself; everything behind it
 * can, and previously none of it was, because there was no authenticated state
 * to drive (see `screens.spec.ts`'s note).
 *
 * Auth.js is configured with `session: { strategy: 'database' }` (src/auth.ts,
 * BR-001-06/07 — a JWT cannot be revoked before its own expiry). A database
 * session is a `sessions` row plus a cookie holding its token, and nothing
 * else: no signature, no secret, no provider involvement. Seeding both is
 * therefore the *complete* authenticated state, not an approximation of it —
 * the server does the same `sessions` lookup it does for a real user and
 * cannot tell the difference, which is the property that makes this worth
 * having.
 *
 * This is test infrastructure and no credential passes through it. It is also
 * why the fixture writes with the **migrator** role: `sessions` is looked up
 * before `app.user_id` can be set, so it is deliberately outside RLS
 * (`src/db/shared-tables.ts`), and the app role has no business inserting one.
 * ---------------------------------------------------------------------------
 */

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://allmywallet_migrator:allmywallet@localhost:5432/allmywallet';

/**
 * Auth.js v5's cookie name. The `__Secure-` prefix is added only over https;
 * the E2E server is plain http on localhost, so the bare name is correct here
 * and a mismatch would present as "the fixture ran and the user is still
 * signed out" rather than as an error.
 */
const SESSION_COOKIE = 'authjs.session-token';

const SESSION_LIFETIME_MS = 60 * 60 * 1000;

export interface SeededSession {
  readonly userId: string;
  readonly sessionToken: string;
}

export async function seedSession(email?: string): Promise<SeededSession> {
  const userId = randomUUID();
  const sessionToken = randomUUID();
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });

  try {
    await pool.query(
      `INSERT INTO users (id, google_subject_id, email, name)
       VALUES ($1, $2, $3, $4)`,
      [userId, `google-subject-${userId}`, email ?? `${userId}@example.test`, 'E2E'],
    );
    await pool.query(
      `INSERT INTO sessions (session_token, user_id, expires)
       VALUES ($1, $2, $3)`,
      [sessionToken, userId, new Date(Date.now() + SESSION_LIFETIME_MS)],
    );
  } finally {
    await pool.end();
  }

  return { userId, sessionToken };
}

/**
 * Deletes the tenant this fixture created. `users` cascades, so this also
 * removes every row the journey wrote — which matters because the E2E database
 * is shared across the whole run and a leftover tenant would make the *next*
 * spec's "your portfolio is empty" assertions depend on test ordering
 * (TS-33/TS-34).
 */
export async function dropSeededUser(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATION_URL, max: 1 });
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  } finally {
    await pool.end();
  }
}

/**
 * The cookie is scoped by the URL Playwright is actually driving, taken from
 * the `baseURL` fixture rather than from the environment: an empty
 * `E2E_BASE_URL` is a string, not nullish, so reading the variable directly
 * produces `url: ''` and a rejected cookie — a failure that presents as "the
 * page is signed out" three assertions later.
 */
async function attachSession(
  context: BrowserContext,
  sessionToken: string,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sessionToken,
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

/**
 * `test` with a signed-in page and the tenant's id available to assert
 * against. Each test gets its own tenant, torn down afterwards.
 */
export const test = base.extend<{ signedIn: { page: Page; userId: string } }>({
  signedIn: async ({ context, page, baseURL }, use) => {
    const session = await seedSession();
    await attachSession(context, session.sessionToken, baseURL ?? 'http://localhost:3000');
    try {
      await use({ page, userId: session.userId });
    } finally {
      await dropSeededUser(session.userId);
    }
  },
});

export { expect } from '@playwright/test';
