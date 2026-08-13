import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@/db/schema/users';

/**
 * SPEC-002 — configuration layer tables.
 *
 * The RLS policy is still hand-added to the generated migration (AR-14) —
 * Drizzle does not model policies. The foreign key below is not: it was raw
 * SQL while this spec was built on a branch where `users` did not exist, and
 * became expressible the moment #4 landed underneath it. Declaring it here
 * rather than leaving it hand-written is what keeps `drizzle-kit generate`
 * able to diff this table correctly next time someone changes it.
 */

/**
 * BR-002-05/AR-42: operator-set configuration only. System-adjusted values
 * live in `runtimeState`, a separate table, so a deploy can never silently
 * revert an autonomous adjustment by overwriting the row it would share with
 * operator config (BR-002-06, DL-002-02).
 *
 * `level = 'deployment'` rows are global (`user_id IS NULL`); `'tenant'` and
 * `'user'` rows are scoped to one account and are tenant data (BR-002-10),
 * hence the RLS policy hand-added in the migration (AR-14).
 */
export const configOverrides = pgTable(
  'config_overrides',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    level: text('level').notNull(),
    // NULL only for level = 'deployment' — enforced by the CHECK below, not
    // by nullability alone, since the two other levels require it set.
    // AR-26/AR-27: the cascade is load-bearing. It is what makes SPEC-004's
    // account deletion complete for a user's stored preferences without a
    // bespoke cleanup step that could be forgotten.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('config_overrides_key_level_user_id_key').on(table.key, table.level, table.userId),
    index('config_overrides_user_id_idx').on(table.userId),
    index('config_overrides_key_idx').on(table.key),
    check('config_overrides_level_check', sql`${table.level} IN ('deployment', 'tenant', 'user')`),
    // SPEC-002 BR-002-02/BR-002-10: deployment rows are global; tenant/user
    // rows are tenant-scoped and must carry the account they belong to.
    check(
      'config_overrides_level_user_id_check',
      sql`(${table.level} = 'deployment' AND ${table.userId} IS NULL) OR (${table.level} IN ('tenant', 'user') AND ${table.userId} IS NOT NULL)`,
    ),
  ],
);

/**
 * BR-002-05/AR-42: values the system adjusts autonomously — SPEC-008's
 * cadence degradation is the first consumer (BR-008-22). Never written by an
 * operator action; `reason` is what lets `effective.ts` show *why* a value
 * differs from what an operator configured (BR-002-06).
 *
 * Not tenant data — it is one process-wide value per key (e.g. the current
 * degraded quote-poll cadence), never a per-user value, and holds nothing
 * personal. Not one of AR-15's five named shared-reference tables either, so
 * it needs its own explicit exemption rather than inheriting theirs.
 *
 * DECISION (flagged for the issue's Decision log, not a silent edit): this
 * table belongs on the AR-15/`SHARED_TABLES` declared-exempt list, on the
 * same "holds no personal data" test AR-15 itself states — not "is reference
 * data" specifically. Left for the orchestrator to add to
 * src/db/shared-tables.ts (not present on this worktree) and to confirm
 * against SPEC-003 BR-003-06, since that file's exact shape isn't visible
 * here and guessing it risks a merge conflict with the real one.
 */
export const runtimeState = pgTable('runtime_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  reason: text('reason').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * BR-002-07: every configuration change that affects behaviour is recorded
 * here with actor, previous and new value. Not in the issue's Modules table —
 * added because BR-002-07 and the "no AuditLog" gap would otherwise be
 * unimplementable; see the dispatch report for the full rationale.
 *
 * Deliberately has no `user_id` foreign key: `actor` is a free-text
 * identifier (`'system'`, `'operator'`, or a user id string), not a relation.
 * That keeps this table outside the "tenant-scoped table" convention (AR-26)
 * that would otherwise require RLS and an isolation test for a table whose
 * primary audience is operators, not the acting user themselves.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityKey: text('entity_key').notNull(),
  previousValue: jsonb('previous_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
