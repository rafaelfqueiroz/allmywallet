-- SPEC-005 BR-005-20f (#215): the reason a user gave for marking an
-- `unclassified` row `ignored`. Expand-only and nullable, so the previous
-- image runs unchanged on this schema (AR-69): it never reads the column and
-- every row it writes leaves it null. `import_rows` already has its RLS
-- policy (AR-14, 0009); a new column needs no policy of its own.
ALTER TABLE "import_rows" ADD COLUMN "ignored_reason" text;
