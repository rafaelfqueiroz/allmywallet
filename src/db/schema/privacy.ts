import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@/db/schema/users';

/**
 * SPEC-004 — LGPD data-subject-rights tables.
 *
 * `consents` is the only *new* tenant-scoped table this spec introduces.
 * `audit_log` (SPEC-002, `src/db/schema/config.ts`) is extended in that file
 * rather than here — see the comment there and the Decision log entry in the
 * #7 dispatch report for why it stays a single declaration next to the table
 * it belongs to.
 */

/**
 * BR-004-05/06/07: one row per `(user, purpose)` — a purpose is either
 * currently granted, currently revoked, or has never been decided (no row at
 * all). `grantedAt`/`revokedAt` are cleared/set on top of the SAME row rather
 * than appending a new one each time, so "the current state of this user's
 * consent for this purpose" is always a single, unambiguous read with no
 * ORDER BY — the full *history* of grant/revoke cycles is not modelled here
 * on purpose (DL-004 note in the #7 report): every write also lands an
 * `audit_log` row (`consent.granted` / `consent.revoked`) via
 * `src/adapters/db/audit-log.ts`, which is the append-only trail BR-004-07's
 * "recorded" actually calls for. Two mechanisms for two different questions —
 * "what does the user currently allow" (this table) versus "what happened,
 * in order" (`audit_log`) — is simpler than one table trying to answer both.
 */
export const CONSENT_PURPOSES = ['email_reminders', 'product_analytics'] as const;

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey(),
    // AR-26/AR-27: cascade is load-bearing — a deleted account's consent
    // decisions are tenant data and must disappear with everything else
    // (BR-004-10).
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // BR-004-07: "the policy version in force at that moment" — a free-text
    // version tag (`'2026-01-01'`, a semver, whatever the policy page's own
    // versioning scheme ends up being), not a foreign key to a policy-text
    // table this spec does not introduce.
    policyVersion: text('policy_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('consents_user_id_purpose_key').on(table.userId, table.purpose),
    index('consents_user_id_idx').on(table.userId),
    check(
      'consents_purpose_check',
      sql`${table.purpose} IN (${sql.raw(CONSENT_PURPOSES.map((p) => `'${p}'`).join(', '))})`,
    ),
    // A row can't be simultaneously "never granted" and "revoked" — revoking
    // requires a prior grant to revoke.
    check(
      'consents_revoked_requires_granted_check',
      sql`${table.revokedAt} IS NULL OR ${table.grantedAt} IS NOT NULL`,
    ),
  ],
);
