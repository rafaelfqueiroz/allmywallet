-- SPEC-005 BR-005-14 / SPEC-007 BR-007-08 (#136): merge the institution rows
-- B3 created by spelling one broker several ways — `INTER DTVM LTDA` beside
-- `INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA`, three spellings
-- of XP — into one row each. A position is keyed by `(asset, institution)`, so
-- each spelling was its own custody location: WEGE3's buys sat on one and its
-- `Desdobro` on the other, and the event refused `no_basis` against a position
-- of zero.
--
-- The identity rule lives in `core/ingestion/institution-identity.ts` and is
-- restated below, once, in SQL. Two parts, in this order:
--
--   1. mechanical — case, accents, punctuation and whitespace runs carry no
--      meaning, so two names differing only in those are one institution;
--   2. the explicit alias table — `INTER DTVM LTDA` is an abbreviation of its
--      expansion, and nothing mechanical brings those together without also
--      merging `CLEAR CORRETORA - GRUPO XP` into XP, or `BANCO INTER S/A`
--      into Inter's DTVM. Both pairs are in this ledger and both must stay
--      apart.
--
-- Adding an alias later does not repair a ledger that has already split on it:
-- rows name an institution by id. Such a change needs a data migration in this
-- shape, as a required step rather than an optional one.
--
-- Data only, no DDL, so the previous image runs on it unchanged (AR-69).
--
-- Per tenant under `app.user_id`: every tenant table is FORCE ROW LEVEL
-- SECURITY, so a non-superuser migrator sees a tenant's rows only with the
-- context set. The personal and CI migrator is a superuser and sees every
-- tenant at once, so every check and write also matches on `user_id` and a
-- repeated pass changes nothing.
--
--   - `transactions` and `import_rows` are re-pointed and the natural key's
--     institution id swapped (`naturalKeyFor`: date|asset|institution|type|
--     qty|price). Occurrences are kept.
--   - A natural-key clash **aborts the migration**, writing nothing. Two rows
--     that collide after the swap are the same date, asset, type, quantity and
--     price at what is now one institution: either two genuinely identical
--     trades, or one trade exported twice under two spellings. Nothing in the
--     data tells those apart, and renumbering the second would silently double
--     a holding.
--   - `positions` is a **cache** (BR-006-01, DM-4). Where only one side holds
--     the position it is re-pointed, which is exactly its replay. Where both
--     sides do, the merged position is not the sum of the two — a sale removes
--     cost at the average it met, and the two halves met different averages —
--     so both rows are deleted and the ledger, which is authoritative, is
--     replayed back into the cache by `node dist/ops.js rebuild-positions`.
--     That command is a required step of this upgrade; until it runs, the
--     merged holdings read as zero rather than as a figure nothing produced.
DO $$
DECLARE
  merge record;
  tenant record;
BEGIN
  -- The alias table, restated. The normalisation is inlined rather than
  -- installed as a function: this migration is its only caller, and a
  -- permanent function would be DDL outliving it.
  CREATE TEMP TABLE institution_alias ON COMMIT DROP AS
  WITH aliases(canonical_name, spelling) AS (
    VALUES
      ('INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA', 'INTER DTVM LTDA'),
      ('XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
       'XP INVESTIMENTOS CCTVM S/A'),
      ('XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
       'XP INVESTIMENTOS CORRETORA DE CAMBIO, TITULOS E VALORES MOBI')
  )
  SELECT canonical_name,
         btrim(regexp_replace(upper(spelling), '[^A-Z0-9]+', ' ', 'g')) AS spelling_key,
         btrim(regexp_replace(upper(canonical_name), '[^A-Z0-9]+', ' ', 'g')) AS canonical_key
    FROM aliases;

  CREATE TEMP TABLE institution_merge ON COMMIT DROP AS
  WITH normalized AS (
    SELECT i.id,
           i.name,
           btrim(regexp_replace(
             upper(translate(i.name,
               'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäåéèêëíìîïóòôõöúùûüçñ',
               'AAAAAAEEEEIIIIOOOOOUUUUCNaaaaaaeeeeiiiiooooouuuucn')),
             '[^A-Z0-9]+', ' ', 'g')) AS normalized_name
      FROM institutions i
  ),
  identified AS (
    SELECT n.id,
           n.name,
           COALESCE(a.canonical_key, n.normalized_name) AS identity_key,
           a.canonical_name
      FROM normalized n
      LEFT JOIN institution_alias a ON a.spelling_key = n.normalized_name
  ),
  -- One row of each identity survives: the one the alias table names, where it
  -- exists, and otherwise the first by name. Never "whichever Postgres
  -- returned first" — two runs of this migration must choose the same row.
  ranked AS (
    SELECT id, name, identity_key,
           row_number() OVER (
             PARTITION BY identity_key
             ORDER BY (canonical_name IS NOT DISTINCT FROM name) DESC, name
           ) AS rank
      FROM identified
  )
  SELECT r.id AS legacy_id, r.name AS legacy_name, k.id AS canonical_id, k.name AS canonical_name
    FROM ranked r
    JOIN ranked k ON k.identity_key = r.identity_key AND k.rank = 1
   WHERE r.rank > 1;

  FOR merge IN SELECT * FROM institution_merge LOOP
    FOR tenant IN SELECT id FROM users LOOP
      PERFORM set_config('app.user_id', tenant.id::text, true);

      IF EXISTS (
        SELECT 1 FROM transactions t
          JOIN transactions o
            ON o.user_id = t.user_id
           AND o.natural_key = replace(t.natural_key, merge.legacy_id::text, merge.canonical_id::text)
           AND o.occurrence = t.occurrence
           AND o.id <> t.id
         WHERE t.institution_id = merge.legacy_id
           AND t.user_id = tenant.id
      ) THEN
        RAISE EXCEPTION '#136: institution % holds a transaction whose natural key clashes with one at % after the merge; nothing was merged',
          merge.legacy_id, merge.canonical_id;
      END IF;

      UPDATE transactions
         SET institution_id = merge.canonical_id,
             natural_key = replace(natural_key, merge.legacy_id::text, merge.canonical_id::text),
             updated_at = now()
       WHERE institution_id = merge.legacy_id
         AND user_id = tenant.id;

      UPDATE import_rows
         SET institution_id = merge.canonical_id,
             natural_key = replace(natural_key, merge.legacy_id::text, merge.canonical_id::text),
             updated_at = now()
       WHERE institution_id = merge.legacy_id
         AND user_id = tenant.id;

      -- A stored reconciliation report names the institution of every
      -- discrepancy, and BR-005-25's adjustment is posted at it. One still
      -- naming the deleted row could not be accepted against the ledger.
      UPDATE import_batches
         SET reconciliation = replace(
               reconciliation::text, merge.legacy_id::text, merge.canonical_id::text
             )::jsonb
       WHERE user_id = tenant.id
         AND reconciliation IS NOT NULL
         AND reconciliation::text LIKE '%' || merge.legacy_id::text || '%';

      -- Both sides held the same asset: neither cached figure survives the
      -- merge, and no arithmetic here reproduces the replay that does.
      DELETE FROM positions p
       WHERE p.user_id = tenant.id
         AND p.institution_id IN (merge.legacy_id, merge.canonical_id)
         AND EXISTS (
           SELECT 1 FROM positions l
            WHERE l.user_id = p.user_id AND l.asset_id = p.asset_id
              AND l.institution_id = merge.legacy_id
         )
         AND EXISTS (
           SELECT 1 FROM positions c
            WHERE c.user_id = p.user_id AND c.asset_id = p.asset_id
              AND c.institution_id = merge.canonical_id
         );

      -- Only one side held it: re-pointing the row *is* its replay, because
      -- the merged transaction set for that position is the one it already
      -- cached.
      UPDATE positions
         SET institution_id = merge.canonical_id,
             updated_at = now()
       WHERE institution_id = merge.legacy_id
         AND user_id = tenant.id;
    END LOOP;

    -- Every reference is a tenant row, so the loop above left none. A foreign
    -- key violation here would mean a table this migration does not know about
    -- names an institution — which must stop the merge, not be worked around.
    DELETE FROM institutions WHERE id = merge.legacy_id;
  END LOOP;

  -- A group whose canonical spelling B3 never wrote survives under the
  -- spelling it did write. Renaming it after the merge can meet no unique
  -- conflict: a row already holding that name would have been in this same
  -- group and merged into it.
  UPDATE institutions i
     SET name = a.canonical_name, updated_at = now()
    FROM institution_alias a
   WHERE i.name <> a.canonical_name
     AND btrim(regexp_replace(
           upper(translate(i.name,
             'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäåéèêëíìîïóòôõöúùûüçñ',
             'AAAAAAEEEEIIIIOOOOOUUUUCNaaaaaaeeeeiiiiooooouuuucn')),
           '[^A-Z0-9]+', ' ', 'g')) = a.spelling_key;
END
$$;
