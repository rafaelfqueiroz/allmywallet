-- SPEC-016 AR-50: the worker's own liveness heartbeat for /api/health.
-- Deliberately not RLS-scoped — see src/db/schema/observability.ts and its
-- SHARED_TABLES entry in src/db/shared-tables.ts. It holds a process
-- identity string and a timestamp, nothing derived from any tenant's data,
-- on the same "holds no personal data" test AR-15 applies to runtime_state.
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
