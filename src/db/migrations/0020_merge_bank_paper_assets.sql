-- SPEC-005 BR-005-06/14..17/22..24 (#115): merge each bank-paper asset a
-- Movimentação import coded by its whole `Produto` (`CDB - CDB6269CPH4`,
-- `CDB - CDBA256IQS1 - BANCO INTER S/A`) into the asset Posição codes by
-- `Código` (`CDB6269CPH4`). The ledger held the applications on one and the
-- snapshot on the other, so reconciliation computed zero. The parser now reads
-- the code (`movimentacao.ts`, same pattern as below); this settles what it
-- already wrote, so a re-import meets the rows instead of importing them again.
--
-- A data migration rather than an import-time alias: it runs once, before the
-- new image starts and after its backup (SPEC-021), in the migration's own
-- transaction, and leaves no permanent lookup in the import path.
--
-- Data only, no DDL, so the previous image runs on it unchanged (AR-69).
--
-- Per tenant under `app.user_id`: every tenant table is FORCE ROW LEVEL
-- SECURITY, so a non-superuser migrator sees a tenant's rows only with the
-- context set. The personal and CI migrator is a superuser and sees every
-- tenant at once, so every check and write also matches on `user_id` and a
-- repeated pass changes nothing.
--
--   - No canonical asset yet (no Posição imported): the asset is renamed, and
--     nothing else moves — every key names it by id.
--   - Canonical asset exists: every row is re-pointed and the natural key's
--     asset id swapped (`naturalKeyFor`: date|asset|institution|type|qty|price).
--     Occurrences are kept. A fixed-income contract already on the canonical
--     asset wins, because only Posição writes one. Positions are a cache of the
--     re-pointed transactions and move with them.
--   - Any other clash (a key, a position, an allocation, a target, a rule on
--     both assets) aborts the migration, writing nothing, rather than guessing
--     which row is real. The canonical asset only ever received Posição rows,
--     which carry no key and no position, so none is expected.
DO $$
DECLARE
  legacy record;
  tenant record;
  canonical_id uuid;
BEGIN
  FOR legacy IN
    SELECT id, code,
           substring(code from '(?i)^(?:CDB|LCI|LCA) - ((?:CDB|LCI|LCA)[A-Z0-9]{5,})(?: - .+)?$') AS canonical_code
      FROM assets
     WHERE code ~* '^(CDB|LCI|LCA) - (CDB|LCI|LCA)[A-Z0-9]{5,}( - .+)?$'
  LOOP
    SELECT id INTO canonical_id FROM assets WHERE code = legacy.canonical_code;

    IF canonical_id IS NULL THEN
      UPDATE assets SET code = legacy.canonical_code, updated_at = now() WHERE id = legacy.id;
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
         WHERE t.asset_id = legacy.id
      ) OR EXISTS (
        SELECT 1 FROM positions p
          JOIN positions o
            ON o.asset_id = canonical_id
           AND o.institution_id IS NOT DISTINCT FROM p.institution_id
           AND o.user_id = p.user_id
         WHERE p.asset_id = legacy.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_allocations a
          JOIN wallet_allocations o ON o.wallet_id = a.wallet_id AND o.asset_id = canonical_id
         WHERE a.asset_id = legacy.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_targets w
          JOIN wallet_targets o ON o.wallet_id = w.wallet_id AND o.asset_id = canonical_id
         WHERE w.asset_id = legacy.id
      ) OR EXISTS (
        SELECT 1 FROM wallet_asset_rules r
          JOIN wallet_asset_rules o ON o.user_id = r.user_id AND o.asset_id = canonical_id
         WHERE r.asset_id = legacy.id
      ) OR EXISTS (
        SELECT 1 FROM opportunity_rules r
          JOIN opportunity_rules o ON o.user_id = r.user_id AND o.asset_id = canonical_id
         WHERE r.asset_id = legacy.id
      ) THEN
        RAISE EXCEPTION '#115: asset % holds rows that clash with its canonical asset %; nothing was merged',
          legacy.id, canonical_id;
      END IF;

      UPDATE transactions
         SET asset_id = canonical_id,
             natural_key = replace(natural_key, legacy.id::text, canonical_id::text)
       WHERE asset_id = legacy.id;

      UPDATE import_rows
         SET asset_id = canonical_id,
             natural_key = replace(natural_key, legacy.id::text, canonical_id::text),
             parsed_payload = jsonb_set(parsed_payload, '{assetCode}', to_jsonb(legacy.canonical_code))
       WHERE asset_id = legacy.id;

      -- A stored reconciliation report names assets by id and code; one that
      -- still named the legacy asset could not be accepted against the ledger.
      UPDATE import_batches
         SET reconciliation = replace(
               replace(reconciliation::text, legacy.id::text, canonical_id::text),
               to_jsonb(legacy.code)::text,
               to_jsonb(legacy.canonical_code)::text
             )::jsonb
       WHERE reconciliation IS NOT NULL
         AND reconciliation::text LIKE '%' || legacy.id::text || '%';

      UPDATE positions SET asset_id = canonical_id WHERE asset_id = legacy.id;

      DELETE FROM fixed_income_contracts c
       WHERE c.asset_id = legacy.id
         AND EXISTS (
           SELECT 1 FROM fixed_income_contracts o
            WHERE o.asset_id = canonical_id AND o.user_id = c.user_id
         );
      UPDATE fixed_income_contracts SET asset_id = canonical_id WHERE asset_id = legacy.id;

      UPDATE wallet_allocations SET asset_id = canonical_id WHERE asset_id = legacy.id;
      UPDATE wallet_allocation_events SET asset_id = canonical_id WHERE asset_id = legacy.id;
      UPDATE wallet_targets SET asset_id = canonical_id WHERE asset_id = legacy.id;
      UPDATE wallet_asset_rules SET asset_id = canonical_id WHERE asset_id = legacy.id;
      UPDATE opportunity_rules SET asset_id = canonical_id WHERE asset_id = legacy.id;
    END LOOP;

    -- Quotes and gaps cascade; bank paper has none (SPEC-009 accrues it).
    DELETE FROM assets WHERE id = legacy.id;
  END LOOP;
END
$$;
