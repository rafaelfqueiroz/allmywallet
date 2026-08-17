-- #63 (SPEC-005 half) — a `failed` terminal status for `import_batches`, and
-- the column that carries why.
--
-- Before this migration, a parse failure (BR-005-05) left the batch stuck at
-- `pending` forever: no status existed for "this will never succeed", and the
-- uploaded `.xlsx` — the one artefact in the system holding a raw CPF
-- (DL-005-07) — was never deleted because nothing ever reached the
-- delete-on-terminal-state code path `handleImportCommit`/`handleImportCancel`
-- already had.
--
-- Both changes are additive and expand/contract safe (AR-69) against the
-- previous application version, which is what a no-staging-environment
-- deploy requires:
--   * The CHECK constraint is WIDENED (one more allowed value) — every status
--     the previous version ever writes remains valid.
--   * `failure_code` is a NULLABLE column the previous version's inserts and
--     updates never reference — it defaults to NULL and stays out of their way.
-- Nothing is renamed or dropped, so this is also safe to leave in place if the
-- deploy that starts writing `failed` is rolled back: the previous version
-- simply never produces that status or reads that column.
--
-- `failure_code` is deliberately `text`, not `jsonb`: it carries the
-- `IngestionErrorCode` alone, never the structural context (which column,
-- what format was expected) that accompanies it in logs — and never, under
-- any circumstance, the malformed cell's own text (BR-004-04/AR-39, SPEC-004
-- BR-004-02). `import_batches` already has its RLS policy from #6
-- (SPEC-006) and this migration does not touch it.

ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_status_check";--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_status_check" CHECK ("import_batches"."status" IN ('pending', 'previewed', 'committed', 'discarded', 'failed'));
