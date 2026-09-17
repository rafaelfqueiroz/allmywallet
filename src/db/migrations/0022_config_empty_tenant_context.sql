-- SPEC-002 BR-002-10 / AR-11 / #113 PR-B.
--
-- `set_config('app.user_id', <uuid>, true)` is transaction-local, but after
-- that transaction ends PostgreSQL keeps the custom GUC known with the empty
-- string on that pooled session. The original tenant policy cast the setting
-- directly to uuid, so a later deployment-config read on the same connection
-- failed with 22P02 before the separate deployment policy could admit it.
-- Treating the empty post-transaction value as NULL preserves fail-closed
-- tenant reads while allowing the documented no-tenant deployment reads.
DROP POLICY "tenant_isolation" ON "config_overrides";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "config_overrides"
	USING ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
	WITH CHECK ("user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
