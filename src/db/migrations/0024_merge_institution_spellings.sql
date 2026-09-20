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
-- Data only, no DDL, so the previous image runs on it unchanged (AR-69). That
-- previous image's resolver still upserts B3's raw spelling, so an import
-- performed while rolled back re-opens a split this migration closed.
--
-- Per tenant under `app.user_id`: every tenant table is FORCE ROW LEVEL
-- SECURITY, so a non-superuser migrator sees a tenant's rows only with the
-- context set. The personal and CI migrator is a superuser and sees every
-- tenant at once, so every check and write also matches on `user_id` and a
-- repeated pass changes nothing.
--
-- **A group is merged whole, never pairwise.** XP has three spellings here,
-- and a pairwise merge would settle two of them and then read the third as if
-- it were the only holder — leaving a cached position covering a third of the
-- ledger, with a plausible figure and nothing to say it was wrong.
--
--   - `transactions` and `import_rows` are re-pointed and the natural key's
--     institution id swapped (`naturalKeyFor`: date|asset|institution|type|
--     qty|price). Occurrences are kept.
--   - A natural-key clash **aborts the migration**, writing nothing. Two rows
--     that collide after the swap are the same date, asset, type, quantity and
--     price at what is now one institution: either two genuinely identical
--     trades, or one trade exported twice under two spellings. Nothing in the
--     data tells those apart, and renumbering the second would silently double
--     a holding. The check compares every rewritten key in the group against
--     every other, so two legacy spellings colliding with each other are
--     caught as well as either colliding with the survivor.
--   - `positions` is a **cache** (BR-006-01, DM-4), and what it may keep is
--     decided from the **ledger**, not from itself. Where the group's
--     transactions for one asset all sit at a single spelling, the cached row
--     is re-pointed — that is exactly its replay. Where they span two or more,
--     every cached row for that asset in the group is deleted: the merged
--     position is not the sum of the parts, because a sale removes cost at the
--     average it met and the parts met different averages. `scripts/personal/
--     start.sh` replays the ledger back into the cache immediately after this
--     migration, through `dist/ops.js rebuild-positions`.
--   - A **soft-deleted** tenant is merged like any other — its rows hold the
--     foreign keys that would otherwise block deleting the institution — but
--     `rebuild-positions` skips it (SPEC-004's grace window). An account
--     restored within that window needs `positions:rebuild --user <id>`.
DO $$
DECLARE
  grp record;
  member record;
  tenant record;
BEGIN
  -- The alias table, restated, with each canonical name listed as a spelling
  -- of itself so the survivor of a group can be recognised by name.
  CREATE TEMP TABLE institution_alias ON COMMIT DROP AS
  WITH aliases(canonical_name, spelling) AS (
    VALUES
      ('INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
       'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA'),
      ('INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA', 'INTER DTVM LTDA'),
      ('XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
       'XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A'),
      ('XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
       'XP INVESTIMENTOS CCTVM S/A'),
      ('XP INVESTIMENTOS CORRETORA DE CAMBIO TITULOS E VALORES MOBILIARIOS S/A',
       'XP INVESTIMENTOS CORRETORA DE CAMBIO, TITULOS E VALORES MOBI')
  )
  SELECT canonical_name,
         -- The same normalisation the names below get, so the two sides of the
         -- comparison are built the same way and cannot drift apart.
         btrim(regexp_replace(
           upper(regexp_replace(normalize(spelling, NFD), '[^\x20-\x7E]', '', 'g')),
           '[^A-Z0-9]+', ' ', 'g')) AS spelling_key,
         btrim(regexp_replace(
           upper(regexp_replace(normalize(canonical_name, NFD), '[^\x20-\x7E]', '', 'g')),
           '[^A-Z0-9]+', ' ', 'g')) AS canonical_key
    FROM aliases;

  -- Every institution mapped to the row that survives its group.
  -- `normalize(…, NFD)` then dropping what is not printable ASCII removes the
  -- combining marks `institution-identity.ts` removes, without a hand-kept
  -- list of accented characters for the two sides to disagree over.
  CREATE TEMP TABLE institution_identity ON COMMIT DROP AS
  WITH normalized AS (
    SELECT i.id,
           i.name,
           btrim(regexp_replace(
             upper(regexp_replace(normalize(i.name, NFD), '[^\x20-\x7E]', '', 'g')),
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
  SELECT r.id, r.name, k.id AS canonical_id
    FROM ranked r
    JOIN ranked k ON k.identity_key = r.identity_key AND k.rank = 1;

  FOR grp IN
    SELECT canonical_id FROM institution_identity
     WHERE id <> canonical_id
     GROUP BY canonical_id
  LOOP
    FOR tenant IN SELECT id FROM users LOOP
      PERFORM set_config('app.user_id', tenant.id::text, true);

      IF EXISTS (
        SELECT 1
          FROM (
            SELECT replace(t.natural_key, t.institution_id::text, grp.canonical_id::text) AS key,
                   t.occurrence
              FROM transactions t
             WHERE t.user_id = tenant.id
               AND t.institution_id IN (
                 SELECT id FROM institution_identity WHERE canonical_id = grp.canonical_id
               )
          ) rewritten
         GROUP BY rewritten.key, rewritten.occurrence
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION '#136: two transactions would share one natural key at institution % after the merge; nothing was merged',
          grp.canonical_id;
      END IF;

      -- Decided before anything moves: once the ledger is re-pointed, every
      -- row reads as one institution and the question cannot be asked.
      DELETE FROM positions p
       WHERE p.user_id = tenant.id
         AND p.institution_id IN (
           SELECT id FROM institution_identity WHERE canonical_id = grp.canonical_id
         )
         AND (
           (SELECT count(DISTINCT t.institution_id)
              FROM transactions t
             WHERE t.user_id = p.user_id
               AND t.asset_id = p.asset_id
               AND t.institution_id IN (
                 SELECT id FROM institution_identity WHERE canonical_id = grp.canonical_id
               )) > 1
           OR
           (SELECT count(DISTINCT q.institution_id)
              FROM positions q
             WHERE q.user_id = p.user_id
               AND q.asset_id = p.asset_id
               AND q.institution_id IN (
                 SELECT id FROM institution_identity WHERE canonical_id = grp.canonical_id
               )) > 1
           OR
           -- A cached row whose own spelling holds none of the asset's
           -- transactions describes a ledger that is not there.
           NOT EXISTS (
             SELECT 1 FROM transactions t
              WHERE t.user_id = p.user_id
                AND t.asset_id = p.asset_id
                AND t.institution_id = p.institution_id
           )
         );

      FOR member IN
        SELECT id FROM institution_identity
         WHERE canonical_id = grp.canonical_id AND id <> grp.canonical_id
      LOOP
        UPDATE transactions
           SET institution_id = grp.canonical_id,
               natural_key = replace(natural_key, member.id::text, grp.canonical_id::text),
               updated_at = now()
         WHERE institution_id = member.id
           AND user_id = tenant.id;

        UPDATE import_rows
           SET institution_id = grp.canonical_id,
               natural_key = replace(natural_key, member.id::text, grp.canonical_id::text),
               updated_at = now()
         WHERE institution_id = member.id
           AND user_id = tenant.id;

        -- A stored reconciliation report names the institution of every
        -- discrepancy, and BR-005-25's adjustment is posted at it. One still
        -- naming the deleted row could not be accepted against the ledger.
        UPDATE import_batches
           SET reconciliation = replace(
                 reconciliation::text, member.id::text, grp.canonical_id::text
               )::jsonb
         WHERE user_id = tenant.id
           AND reconciliation IS NOT NULL
           AND reconciliation::text LIKE '%' || member.id::text || '%';

        -- Whatever survived the delete above is the whole of its asset's
        -- history in this group, so re-pointing it *is* its replay.
        UPDATE positions
           SET institution_id = grp.canonical_id,
               updated_at = now()
         WHERE institution_id = member.id
           AND user_id = tenant.id;
      END LOOP;
    END LOOP;

    -- Every reference is a tenant row, so the loop above left none. A foreign
    -- key violation here would mean a table this migration does not know about
    -- names an institution — which must stop the merge, not be worked around.
    DELETE FROM institutions
     WHERE id IN (
       SELECT id FROM institution_identity
        WHERE canonical_id = grp.canonical_id AND id <> grp.canonical_id
     );
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
           upper(regexp_replace(normalize(i.name, NFD), '[^\x20-\x7E]', '', 'g')),
           '[^A-Z0-9]+', ' ', 'g')) = a.spelling_key;
END
$$;
