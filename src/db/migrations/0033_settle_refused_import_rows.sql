-- SPEC-005 BR-005-17 / SPEC-010 BR-010-12 (#153): settle old refusals whose
-- exact (tenant, natural key, occurrence) now has an active ledger row.
-- This backfills commit-batch.ts's settleEarlierRefusals for imports before
-- #117. As in that helper, a transaction from the refused row's own batch
-- cannot settle it. Unclassified and superseded ledger rows are not evidence.
--
-- Data only: the previous image already understands `duplicate` and these
-- counters, so rollback remains safe (AR-69). No ledger or position changes,
-- no new personal-data copies (SPEC-004), and no RLS bypass. Tenant context is
-- transaction-scoped (AR-11/13); explicit tenant predicates also protect the
-- superuser migrator used by local containers.
DO $$
DECLARE
  tenant record;
  affected_batches uuid[];
BEGIN
  FOR tenant IN SELECT id FROM users LOOP
    PERFORM set_config('app.user_id', tenant.id::text, true);

    WITH settled AS (
      UPDATE import_rows r
         SET classification = 'duplicate', updated_at = now()
       WHERE r.user_id = tenant.id
         AND r.classification = 'invalid'
         AND EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.user_id = tenant.id
              AND t.user_id = r.user_id
              AND t.natural_key = r.natural_key
              AND t.occurrence = r.occurrence
              AND t.status = 'active'
              AND t.import_batch_id IS DISTINCT FROM r.batch_id
         )
      RETURNING r.batch_id
    )
    SELECT array_agg(DISTINCT batch_id) INTO affected_batches FROM settled;

    -- A separate statement sees the classifications just updated. Recompute
    -- summarizeRows's four classification counts from every row in each
    -- affected batch, rather than trusting stale stored counts. Keep `read`,
    -- the date range, and any unrelated JSON metadata exactly as stored; a
    -- classification change cannot change the source's date range.
    UPDATE import_batches b
       SET row_counts = b.row_counts || jsonb_build_object(
             'new', counts.new_count,
             'duplicates', counts.duplicate_count,
             'needsAttention', counts.attention_count,
             'ignored', counts.ignored_count
           ),
           updated_at = now()
      FROM (
        SELECT r.batch_id,
               count(*) FILTER (WHERE r.classification = 'new') AS new_count,
               count(*) FILTER (WHERE r.classification = 'duplicate') AS duplicate_count,
               count(*) FILTER (WHERE r.classification IN ('invalid', 'unclassified')) AS attention_count,
               count(*) FILTER (WHERE r.classification = 'ignored') AS ignored_count
          FROM import_rows r
         WHERE r.user_id = tenant.id
           AND r.batch_id = ANY(affected_batches)
         GROUP BY r.batch_id
      ) counts
     WHERE b.user_id = tenant.id
       AND b.id = counts.batch_id
       AND b.row_counts IS NOT NULL;
  END LOOP;
END
$$;
