-- SPEC-008 BR-008-12 / SPEC-009 BR-009-05 (#152): move every Tesouro Direto
-- price series onto the asset B3 names the title by. `tesouro.sync` catalogued
-- its prices under Tesouro Transparente's product and maturity date
-- (`Tesouro Selic 01/03/2029`) while both B3 extracts create the held asset
-- under product and year (`Tesouro Selic 2029`); nothing linked the two, so
-- every held title was valued at cost.
--
-- The identity rule lives in `core/quotes/tesouro-title.ts` and reaches the
-- catalogue through `parseTesouroCsv`; it is restated below, once, in SQL, so
-- the next sync writes onto the asset this migration keeps.
--
--   - Only the products listed below are translated — the ones whose name year
--     is their maturity year. `Tesouro Educa+` and `Tesouro Renda+` are named
--     for the year payments start, and stay under their full date.
--   - A B3 code that two catalogued maturities would share is left alone,
--     both assets untouched, exactly as the sync declines to price it.
--   - No B3-named asset yet: the full-date asset is renamed, nothing moves.
--   - B3-named asset exists: its **market data** moves — `price_quotes`,
--     `price_quote_gaps`, `latest_quotes`, all shared (AR-15) — and the
--     full-date asset is deleted. Tesouro Transparente's close wins a date
--     both carry: it is the published sell price BR-009-06 requires, and the
--     held asset has no other source. A gap on a date that now has a close is
--     recovered, so it is deleted, as a later recovery would.
--   - **No tenant row moves.** The sync never writes one, and the ledger has
--     always named the title B3's way. A full-date asset some tenant row does
--     name — a transaction typed against it by hand — is a real split between
--     two ledgers, and aborts the migration, writing nothing, rather than
--     being joined by a rule written for market data. The check runs per
--     tenant under `app.user_id`, because every tenant table is FORCE ROW
--     LEVEL SECURITY and a non-superuser migrator sees nothing without it;
--     the foreign keys (no `ON DELETE` action) are the floor under it.
--
-- Data only, no DDL, so the previous image runs on it unchanged (AR-69). That
-- previous image's sync still writes the full-date code, so a sync run while
-- rolled back writes that day's price to a re-created full-date asset nothing
-- holds. The held title carries its last price forward (BR-009-03) until the
-- next forward sync, and the rolled-back days are never backfilled onto it —
-- the sync writes only the latest published date, and this migration does not
-- run again.
--
-- `positions` is untouched — the ledger does not move. Valuation snapshots are
-- rebuilt over the whole history by `start.sh`'s `rebuild-snapshots` step,
-- which reads the moved series.
DO $$
DECLARE
  legacy record;
  tenant record;
  canonical_id uuid;
BEGIN
  CREATE TEMP TABLE tesouro_title ON COMMIT DROP AS
  SELECT a.id, a.code, m[1] || ' ' || m[4] AS canonical_code
    FROM assets a
   CROSS JOIN LATERAL regexp_match(a.code, '^(.+) ([0-9]{2})/([0-9]{2})/([0-9]{4})$') AS m
   WHERE a.class = 'tesouro_direto'
     AND m[1] IN (
       'Tesouro Selic',
       'Tesouro Prefixado',
       'Tesouro Prefixado com Juros Semestrais',
       'Tesouro IPCA+',
       'Tesouro IPCA+ com Juros Semestrais',
       'Tesouro IGPM+ com Juros Semestrais'
     );

  DELETE FROM tesouro_title t
   WHERE (SELECT count(*) FROM tesouro_title o WHERE o.canonical_code = t.canonical_code) > 1;

  FOR legacy IN SELECT * FROM tesouro_title ORDER BY code LOOP
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
        RAISE EXCEPTION '#152: tenant rows name Tesouro asset % (%) beside %; nothing was merged',
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
END
$$;
