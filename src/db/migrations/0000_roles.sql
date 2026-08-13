-- SPEC-003 BR-003-03, BR-003-04 / DL-003-02 / ARCHITECTURE §5:
-- two roles, so a request-serving connection can never bypass RLS — not as a
-- superuser, not as a table owner (which bypasses its own policies unless
-- FORCE is set), not via an explicit BYPASSRLS grant.
--
--   allmywallet_migrator  owns every table, runs DDL. This migration itself
--                         runs as that role (db:migrate connects via
--                         DATABASE_MIGRATION_URL), so it is expected to
--                         already exist — created at cluster init time by
--                         POSTGRES_USER (docker-compose.yml) or by whoever
--                         provisions the database. A migration cannot create
--                         the role it is currently connected as.
--
--   allmywallet_app       runtime role for web + worker. Not the table owner,
--                         and never granted BYPASSRLS. Created here,
--                         idempotently, with no password: setting one is a
--                         one-time operational step sourced from the VPS's
--                         root-only `.env` (AR-43 / BR-003-09) and is never
--                         committed to source control. Local development and
--                         CI provision the same role out of band — see
--                         docker-compose.yml's POSTGRES_* and
--                         tests/support/postgres.ts's ensureAppRole, which
--                         both tolerate this statement being a no-op on
--                         re-entry.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allmywallet_app') THEN
    CREATE ROLE allmywallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO allmywallet_app;
--> statement-breakpoint
-- Tables that exist at the time this migration runs.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO allmywallet_app;
--> statement-breakpoint
-- Every table allmywallet_migrator creates from now on, automatically — so a
-- future migration that adds a table never has to remember this grant. RLS
-- (AR-14, enabled+forced per table) is what actually restricts what the grant
-- lets allmywallet_app reach; the grant alone is table-level, not row-level.
ALTER DEFAULT PRIVILEGES FOR ROLE allmywallet_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO allmywallet_app;
