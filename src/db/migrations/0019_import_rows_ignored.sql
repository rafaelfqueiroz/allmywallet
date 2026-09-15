-- SPEC-005 BR-005-19 (amended, #110): `ignored` — a Movimentação row mirroring a
-- record another extract owns. Expand-only (AR-69): the check only widens, and
-- the previous image reads an `ignored` row as none of its categories, so it
-- neither commits it nor lists it in Needs attention.
ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_classification_check";--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_classification_check" CHECK ("import_rows"."classification" IN ('new', 'duplicate', 'unclassified', 'invalid', 'position', 'ignored'));
