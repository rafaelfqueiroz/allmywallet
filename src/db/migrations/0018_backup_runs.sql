-- SPEC-021 BR-021-20: outcomes of scripts/personal/backup.sh, read by /api/health
-- and the in-app notice. Shared, not RLS-scoped — see its SHARED_TABLES entry:
-- a status, a timestamp, a file name and a failure reason, nothing derived
-- from any tenant. Expand-only (AR-69): a new table, nothing existing touched.
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"file_name" text,
	"detail" text,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_runs_status_check" CHECK ("backup_runs"."status" IN ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_finished_at_idx" ON "backup_runs" USING btree ("finished_at");