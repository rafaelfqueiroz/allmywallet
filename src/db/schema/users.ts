import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { UserId } from '@/core/shared/ids';

/**
 * SPEC-001: `users` is the tenant root. AR-26/AR-27: every *other* tenant
 * table carries `user_id uuid NOT NULL REFERENCES users(id) ON DELETE
 * CASCADE`, which is what makes SPEC-004's account deletion complete just by
 * deleting this row. `users` itself has no `user_id` column and is
 * deliberately **not** RLS-scoped (issue #4) — a policy that referenced
 * `users` to restrict `users` would be circular, and every other table's
 * policy already depends on this one being universally readable by the
 * queries that need to join to it.
 *
 * BR-001-05: personal data stored here is limited to Google subject id,
 * email, display name and profile picture URL. Nothing else — in particular,
 * no `email_verified` bookkeeping column: see `src/auth.ts` for why the
 * generic `@auth/drizzle-adapter` factory (which requires one) is not used.
 */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => UserId.generate()),
  // BR-001-03/DL-001-02: the identity key. Not email — Google emails can
  // change, and matching on a mutable field would silently orphan or merge
  // accounts. Provisioning (core/identity/provision-tenant.ts) upserts on
  // this column, which is what makes a retried OAuth callback idempotent
  // (BR-001-04).
  googleSubjectId: text('google_subject_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Soft marker only. BR-001-09: the account deletion mechanics themselves —
  // review window, purge, backup-cycle expiry — are SPEC-004 (#7). This
  // column exists so #7 has somewhere to record "deletion requested" without
  // a schema change of its own.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/**
 * Auth.js database-session bookkeeping. `src/auth.ts` implements the `Adapter`
 * interface by hand against these tables rather than using
 * `@auth/drizzle-adapter`'s generic Postgres factory — see the comment there
 * for why. Not RLS-scoped: resolving *which* tenant a request belongs to is
 * exactly what a `sessions` lookup by token accomplishes, which means it
 * necessarily runs before `app.user_id` can be set (`src/db/shared-tables.ts`
 * has the full reasoning; flagged there for a second look).
 */
export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per linked OAuth account. BR-001-01 means there is only ever one
 * provider (`google`) in practice today, but the table stays provider-shaped
 * (composite `(provider, provider_account_id)` key) rather than assuming
 * Google specifically — DL-001-01 leaves room for a second provider later
 * without a redesign.
 */
export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refreshToken: text('refresh_token'),
    accessToken: text('access_token'),
    // A timestamp, not Auth.js's raw Unix-epoch integer (AR-29: timestamps
    // are timestamptz, not floats or epoch numbers).
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    tokenType: text('token_type'),
    scope: text('scope'),
    idToken: text('id_token'),
    sessionState: text('session_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

/**
 * Auth.js schema completeness for the Email-provider verification-link flow.
 * Unused today — BR-001-01 permits Google OAuth only, so nothing ever calls
 * `createVerificationToken`/`useVerificationToken` (both omitted from the
 * hand-rolled adapter in `src/auth.ts`) — kept only because the issue's data
 * model names it and a future provider change is one of the few things
 * DL-001-01 explicitly leaves open. Holds no rows in current operation.
 */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);
