-- SPEC-001 (#4) / SPEC-003 (#6): `users` is the tenant root and is
-- deliberately NOT row-level-security-scoped — see the comment on the table
-- itself in src/db/schema/users.ts for why a policy here would be circular.
--
-- `sessions`, `accounts` and `verification_tokens` are likewise NOT
-- RLS-scoped, despite `sessions.user_id` / `accounts.user_id` being NOT NULL
-- columns that would otherwise look tenant-scoped. This is a deliberate,
-- reviewed exemption (declared in src/db/shared-tables.ts as
-- AUTH_SUBSTRATE_TABLES, distinct from SPEC-003 BR-003-06's shared-reference
-- declaration), not an oversight AR-14 review missed:
--
--   Resolving *which* tenant a request belongs to is exactly what a
--   `sessions` lookup by token accomplishes. That lookup necessarily runs
--   before `app.user_id` can be set — a FORCE RLS policy keyed on
--   `current_setting('app.user_id')` would make `current_setting` raise
--   "unrecognized configuration parameter" on every single session lookup,
--   breaking authentication outright rather than merely restricting it.
--
-- The residual risk this accepts, and its mitigation, are documented in
-- src/db/shared-tables.ts and flagged in the #4/#6 report for a second
-- (ac-reviewer) look: only src/auth.ts's hand-rolled Adapter ever queries
-- these tables, session tokens are cryptographically random and looked up by
-- exact match only, and no report/export/aggregate path has any reason to
-- select from them.
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"google_subject_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_google_subject_id_unique" UNIQUE("google_subject_id")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Not RLS-scoping indexes — plain lookup indexes for "sign this user out
-- everywhere" / "list this user's linked accounts", the same reason any
-- foreign key benefits from one.
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");