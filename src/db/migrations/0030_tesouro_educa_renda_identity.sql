-- SPEC-008 BR-008-12 / SPEC-005 BR-005-14 (#164): catalogue Tesouro Educa+ and
-- Tesouro Renda+ Aposentadoria Extra under the name B3 gives them, as 0029 did
-- for every other product. Both are named for the year payments start, not the
-- maturity, so 0029 left them under Tesouro Transparente's full date
-- (`Tesouro Educa+ 15/12/2030`) and a holding imported from B3
-- (`Tesouro Educa+ 2026`) would never have met its price.
--
-- The rule lives in `core/quotes/tesouro-title.ts`, restated here once:
--
--   - `Tesouro Educa+` maturing 15/12/Y is `Tesouro Educa+ (Y-4)`;
--   - `Tesouro Renda+ Aposentadoria Extra` maturing 15/12/Y is
--     `Tesouro Renda+ Aposentadoria Extra (Y-19)`;
--   - any other maturity date does not fit the product and is left alone.
--
-- Everything else is 0029's shape, for the same reasons:
--
--   - No B3-named asset yet (the expected case — nobody has imported one):
--     the full-date asset is renamed, keeping its id and its price history.
--   - B3-named asset exists: its market data moves — `price_quotes`,
--     `price_quote_gaps`, `latest_quotes`, all shared (AR-15) — and the
--     full-date asset is deleted. Tesouro Transparente's close wins a date both
--     carry, and a gap on a date that now has a close is deleted.
--   - **No tenant row moves.** A full-date asset some tenant row names is a
--     split between two ledgers, and aborts the migration, writing nothing.
--     Checked per tenant under `app.user_id` (FORCE ROW LEVEL SECURITY); the
--     foreign keys (no `ON DELETE` action) are the floor under it.
--
-- Data only, no DDL (AR-69). The previous image's sync still writes the
-- full-date code, so a sync run while rolled back re-creates those assets and
-- re-inserts their history beside the renamed ones; nothing holds them, and
-- the next forward sync writes onto the B3-named assets again.
DO $$
DECLARE
  legacy record;
  tenant record;
  canonical_id uuid;
BEGIN
  -- Named apart from 0029's, and dropped at the end: pending migrations apply
  -- in one transaction, so 0029's `ON COMMIT DROP` table still exists here on
  -- a fresh database.
  CREATE TEMP TABLE tesouro_payout_title ON COMMIT DROP AS
  SELECT a.id,
         a.code,
         m[1] || ' ' || (m[2]::int - CASE m[1] WHEN 'Tesouro Educa+' THEN 4 ELSE 19 END)::text
           AS canonical_code
    FROM assets a
   CROSS JOIN LATERAL regexp_match(
     a.code, '^(Tesouro Educa\+|Tesouro Renda\+ Aposentadoria Extra) 15/12/([0-9]{4})$'
   ) AS m
   WHERE a.class = 'tesouro_direto'
     AND m IS NOT NULL;

  FOR legacy IN SELECT * FROM tesouro_payout_title ORDER BY code LOOP
    SELECT id INTO canonical_id FROM assets WHERE code = legacy.canonical_code;

    IF canonical_id IS NULL THEN
      UPDATE assets
         SET code = legacy.canonical_code,
             -- The sync names a title by its code; any other name is left alone.
             name = CASE WHEN name = legacy.code THEN legacy.canonical_code ELSE name END,
             updated_at = now()
       WHERE id = legacy.id;
      CONTINUE;
    END IF;

    FOR tenant IN SELECT id FROM users LOOP
      PERFORM set_config('app.user_id', tenant.id::text, true);
      IF EXISTS (SELECT 1 FROM transactions WHERE asset_id = legacy.id AND user_id = tenant.id)
        OR EXISTS (SELECT 1 FROM import_rows WHERE asset_id = legacy.id AND user_id = tenant.id)
        OR EXISTS (SELECT 1 FROM positions WHERE asset_id = legacy.id AND user_id = tenant.id)
        OR EXISTS (
          SELECT 1 FROM fixed_income_contracts WHERE asset_id = legacy.id AND user_id = tenant.id
        )
        OR EXISTS (SELECT 1 FROM wallet_targets WHERE asset_id = legacy.id AND user_id = tenant.id)
        OR EXISTS (
          SELECT 1 FROM wallet_allocations WHERE asset_id = legacy.id AND user_id = tenant.id
        )
        OR EXISTS (
          SELECT 1 FROM wallet_allocation_events WHERE asset_id = legacy.id AND user_id = tenant.id
        )
        OR EXISTS (
          SELECT 1 FROM wallet_asset_rules WHERE asset_id = legacy.id AND user_id = tenant.id
        )
        OR EXISTS (
          SELECT 1 FROM opportunity_rules WHERE asset_id = legacy.id AND user_id = tenant.id
        )
      THEN
        RAISE EXCEPTION '#164: tenant rows name Tesouro asset % (%) beside %; nothing was merged',
          legacy.id, legacy.code, legacy.canonical_code;
      END IF;
    END LOOP;

    DELETE FROM price_quotes c
     WHERE c.asset_id = canonical_id
       AND EXISTS (
         SELECT 1 FROM price_quotes l WHERE l.asset_id = legacy.id AND l.date = c.date
       );
    UPDATE price_quotes
       SET asset_id = canonical_id, updated_at = now()
     WHERE asset_id = legacy.id;

    DELETE FROM price_quote_gaps l
     WHERE l.asset_id = legacy.id
       AND EXISTS (
         SELECT 1 FROM price_quote_gaps c WHERE c.asset_id = canonical_id AND c.date = l.date
       );
    UPDATE price_quote_gaps
       SET asset_id = canonical_id, updated_at = now()
     WHERE asset_id = legacy.id;
    DELETE FROM price_quote_gaps g
     WHERE g.asset_id = canonical_id
       AND EXISTS (
         SELECT 1 FROM price_quotes q WHERE q.asset_id = canonical_id AND q.date = g.date
       );

    DELETE FROM latest_quotes
     WHERE asset_id = legacy.id
       AND EXISTS (SELECT 1 FROM latest_quotes WHERE asset_id = canonical_id);
    UPDATE latest_quotes
       SET asset_id = canonical_id, updated_at = now()
     WHERE asset_id = legacy.id;

    DELETE FROM assets WHERE id = legacy.id;
  END LOOP;

  DROP TABLE tesouro_payout_title;
END
$$;
