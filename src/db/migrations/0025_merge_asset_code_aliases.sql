-- SPEC-005 BR-005-14 (#135): merge each asset B3 created under a code it uses
-- for one instrument only in a particular context — `ENBR3L`, its auction
-- ticker for the July 2023 Energias do Brasil buyout settlement — into the
-- listed asset it is (`ENBR3`). Negociação printed the disposal under the
-- auction ticker while Movimentação coded both custody legs of the same event
-- `ENBR3`, so the ledger held `ENBR3L` as an asset of its own with no position
-- behind it and both sale rows refused `INSUFFICIENT_QUANTITY` for good.
--
-- The identity rule lives in `core/ingestion/asset-identity.ts` and reaches
-- the catalogue through `DrizzleAssetResolver`; it is restated below, once, in
-- SQL, so a future import meets one asset. This settles what earlier imports
-- already wrote.
--
-- **Listed by hand, never inferred.** `ENBR3L` is the listed code with an `L`
-- appended, and a rule reading it that way would silently capture any real
-- ticker ending in `L`. A wrongly merged pair joins two instruments' holdings
-- into one position with a plausible average and nothing to say it is wrong —
-- worse than the split it fixes, which is at least visible as two rows.
--
-- Data only, no DDL, so the previous image runs on it unchanged (AR-69). That
-- previous image's resolver still upserts B3's raw code, so an import
-- performed while rolled back re-creates the asset this migration removed.
--
-- Per tenant under `app.user_id`: every tenant table is FORCE ROW LEVEL
-- SECURITY, so a non-superuser migrator sees a tenant's rows only with the
-- context set. The personal and CI migrator is a superuser and sees every
-- tenant at once, so every check and write also matches on `user_id` and a
-- repeated pass changes nothing.
--
--   - No canonical asset yet: the asset is renamed to its canonical code and
--     nothing moves — every key names it by id. Its rows' `parsed_payload`
--     still has to be rewritten, or whether a payload says `ENBR3L` or `ENBR3`
--     would depend on which of the two branches ran.
--   - Canonical asset exists: every row is re-pointed and the natural key's
--     asset id swapped (`naturalKeyFor`: date|asset|institution|type|qty|price).
--     Occurrences are kept.
--   - A natural-key clash, an allocation, a target or a rule on both assets
--     aborts the migration, writing nothing, rather than guessing which row is
--     real. Renumbering a colliding transaction would silently double a
--     holding, and nothing in the data tells two identical trades apart.
--   - `positions` is a **cache** (BR-006-01, DM-4), so a collision there is not
--     a reason to refuse an upgrade: both cached rows are deleted and
--     `scripts/personal/start.sh` replays the ledger back into the cache
--     immediately after this migration, through `dist/ops.js
--     rebuild-positions`. `0024` takes the same reading. The merged position
--     is not the sum of the parts — a sale removes cost at the average it met
--     — so re-pointing one over the other would cache a plausible wrong
--     figure, which is the outcome worth avoiding.
--   - A fixed-income contract on the canonical asset wins; an aliased code is
--     a listed ticker and never carries one, so none is expected.
--   - Quotes and price gaps cascade with the deleted asset: they were fetched
--     for a settlement ticker that trades on no other day, and the canonical
--     asset carries the real series.
--   - A **soft-deleted** tenant is merged like any other — its rows hold the
--     foreign keys that would otherwise block deleting the asset — but
--     `rebuild-positions` skips it (SPEC-004's grace window). An account
--     restored within that window needs `positions:rebuild --user <id>`.
DO $$
DECLARE
  legacy record;
  tenant record;
  canonical_id uuid;
BEGIN
  -- The alias table, restated. Each row is one code B3 has written for the
  -- instrument the ledger keeps under `canonical_code`.
  CREATE TEMP TABLE asset_alias ON COMMIT DROP AS
  SELECT *
    FROM (VALUES ('ENBR3L', 'ENBR3')) AS t(code, canonical_code);

  FOR legacy IN
    SELECT a.id, a.code, a.name, x.canonical_code
      FROM assets a
      JOIN asset_alias x ON upper(btrim(a.code)) = x.code
  LOOP
    SELECT id INTO canonical_id FROM assets WHERE code = legacy.canonical_code;

    IF canonical_id IS NULL THEN
      UPDATE assets
         SET code = legacy.canonical_code,
             -- Negociação has no product name, so its ticker doubles as one.
             name = CASE WHEN name = legacy.code THEN legacy.canonical_code ELSE name END,
             updated_at = now()
       WHERE id = legacy.id;

      FOR tenant IN SELECT id FROM users LOOP
        PERFORM set_config('app.user_id', tenant.id::text, true);
        -- The normalised record the refusal screen rebuilds a candidate from:
        -- one still naming the legacy code would read against an asset that is
        -- not there. `raw_payload` is B3's own cells and stays as B3 wrote
        -- them. An extract with no product name lets its code double as one,
        -- so that name moves with the code; any other name is left alone.
        UPDATE import_rows
           SET parsed_payload = jsonb_set(
                 CASE
                   WHEN parsed_payload->>'assetName' = legacy.code
                     THEN jsonb_set(parsed_payload, '{assetName}', to_jsonb(legacy.canonical_code))
                   ELSE parsed_payload
                 END,
                 '{assetCode}', to_jsonb(legacy.canonical_code)
               ),
               updated_at = now()
         WHERE asset_id = legacy.id
           AND user_id = tenant.id
           AND parsed_payload->>'assetCode' = legacy.code;
      END LOOP;
      CONTINUE;
    END IF;

    FOR tenant IN SELECT id FROM users LOOP
      PERFORM set_config('app.user_id', tenant.id::text, true);

      IF EXISTS (
        SELECT 1 FROM transactions t
          JOIN transactions o
            ON o.natural_key = replace(t.natural_key, legacy.id::text, canonical_id::text)
           AND o.occurrence = t.occurrence
           AND o.user_id = t.user_id
         WHERE t.asset_id = legacy.id AND t.user_id = tenant.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_allocations a
          JOIN wallet_allocations o ON o.wallet_id = a.wallet_id AND o.asset_id = canonical_id
         WHERE a.asset_id = legacy.id AND a.user_id = tenant.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_targets w
          JOIN wallet_targets o ON o.wallet_id = w.wallet_id AND o.asset_id = canonical_id
         WHERE w.asset_id = legacy.id AND w.user_id = tenant.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_asset_rules r
          JOIN wallet_asset_rules o ON o.user_id = r.user_id AND o.asset_id = canonical_id
         WHERE r.asset_id = legacy.id AND r.user_id = tenant.id
      ) OR EXISTS (
        SELECT 1 FROM opportunity_rules r
          JOIN opportunity_rules o ON o.user_id = r.user_id AND o.asset_id = canonical_id
         WHERE r.asset_id = legacy.id AND r.user_id = tenant.id
      ) THEN
        RAISE EXCEPTION '#135: asset % holds rows that clash with its canonical asset %; nothing was merged',
          legacy.id, canonical_id;
      END IF;

      -- Decided before anything moves: once the ledger is re-pointed, every
      -- row reads as one asset and the question cannot be asked.
      DELETE FROM positions p
       WHERE p.user_id = tenant.id
         AND p.asset_id IN (legacy.id, canonical_id)
         AND EXISTS (
           SELECT 1 FROM positions o
            WHERE o.user_id = p.user_id
              AND o.asset_id = CASE WHEN p.asset_id = legacy.id THEN canonical_id ELSE legacy.id END
              AND o.institution_id IS NOT DISTINCT FROM p.institution_id
         );

      UPDATE transactions
         SET asset_id = canonical_id,
             natural_key = replace(natural_key, legacy.id::text, canonical_id::text),
             updated_at = now()
       WHERE asset_id = legacy.id AND user_id = tenant.id;

      -- `parsed_payload` is the normalised record, and the refusal screen
      -- rebuilds a candidate from it: one still naming the deleted asset would
      -- read against a ledger that is not there. `raw_payload` is B3's own
      -- cells and is deliberately left as B3 wrote them.
      UPDATE import_rows
         SET asset_id = canonical_id,
             natural_key = replace(natural_key, legacy.id::text, canonical_id::text),
             -- As in the rename branch above, and for the same reason.
             parsed_payload = jsonb_set(
               CASE
                 WHEN parsed_payload->>'assetName' = legacy.code
                   THEN jsonb_set(parsed_payload, '{assetName}', to_jsonb(legacy.canonical_code))
                 ELSE parsed_payload
               END,
               '{assetCode}', to_jsonb(legacy.canonical_code)
             ),
             updated_at = now()
       WHERE asset_id = legacy.id AND user_id = tenant.id;

      -- A stored reconciliation report names assets by id and code; one that
      -- still named the legacy asset could not be accepted against the ledger.
      UPDATE import_batches
         SET reconciliation = replace(
               replace(reconciliation::text, legacy.id::text, canonical_id::text),
               to_jsonb(legacy.code)::text,
               to_jsonb(legacy.canonical_code)::text
             )::jsonb
       WHERE user_id = tenant.id
         AND reconciliation IS NOT NULL
         AND reconciliation::text LIKE '%' || legacy.id::text || '%';

      UPDATE positions
         SET asset_id = canonical_id, updated_at = now()
       WHERE asset_id = legacy.id AND user_id = tenant.id;

      DELETE FROM fixed_income_contracts c
       WHERE c.asset_id = legacy.id
         AND c.user_id = tenant.id
         AND EXISTS (
           SELECT 1 FROM fixed_income_contracts o
            WHERE o.asset_id = canonical_id AND o.user_id = c.user_id
         );
      UPDATE fixed_income_contracts
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;

      UPDATE wallet_allocations
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;
      UPDATE wallet_allocation_events
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;
      UPDATE wallet_targets
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;
      UPDATE wallet_asset_rules
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;
      UPDATE opportunity_rules
         SET asset_id = canonical_id
       WHERE asset_id = legacy.id AND user_id = tenant.id;
    END LOOP;

    DELETE FROM assets WHERE id = legacy.id;
  END LOOP;
END
$$;
