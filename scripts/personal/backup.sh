#!/usr/bin/env bash
#
# SPEC-021 BR-021-16–BR-021-20 — one encrypted backup of the personal database.
#
#   scripts/personal/backup.sh
#
# pg_dump (custom format) → age → $BACKUP_DIR/allmywallet-<UTC stamp>.dump.age,
# plus an encrypted `table|count` sidecar taken inside the dump's own snapshot,
# which is what restore-drill.sh compares against. Plaintext never reaches a
# file: the dump streams from the container straight into `age`.
#
# Exit 0 only when the dump is complete and in place. Every failure is recorded
# in `backup_runs` (BR-021-20) before exiting non-zero, and retention prunes
# only after a success (BR-021-19).
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

counts_plain=""
partial=""
counts_partial=""
cleanup() {
  [ -z "$counts_plain" ] || rm -f "$counts_plain"
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$counts_partial" ] || rm -f "$counts_partial"
}
trap cleanup EXIT

ops() {
  personal_compose run --rm --no-deps -T web node dist/ops.js "$@"
}

fail() {
  log "backup FAILED: $1"
  ops backup-record failed "$1" >/dev/null 2>&1 ||
    log "could not record the failure in backup_runs either — /api/health cannot show it"
  exit 1
}

[ -n "${BACKUP_DIR:-}" ] || fail "BACKUP_DIR is not set in $ALLMYWALLET_ENV_FILE"
[ -d "$BACKUP_DIR" ] || fail "BACKUP_DIR $BACKUP_DIR does not exist — is the backup drive mounted?"
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || fail "BACKUP_AGE_RECIPIENT is not set"
[ -n "${PGDATA_HOST_PATH:-}" ] || fail "PGDATA_HOST_PATH is not set"
[ -e "$PGDATA_HOST_PATH" ] || fail "PGDATA_HOST_PATH $PGDATA_HOST_PATH does not exist"

# BR-021-18: a copy on the disk it protects dies with that disk.
if same_volume "$BACKUP_DIR" "$PGDATA_HOST_PATH"; then
  fail "BACKUP_DIR $BACKUP_DIR is on the same volume as the Postgres data ($PGDATA_HOST_PATH)"
fi
if inside_repo "$BACKUP_DIR"; then
  fail "BACKUP_DIR $BACKUP_DIR is inside the repository working tree"
fi
command -v "$AGE" >/dev/null 2>&1 || fail "age is not installed (brew install age)"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/allmywallet-$stamp.dump.age"
counts_final="$BACKUP_DIR/allmywallet-$stamp.counts.age"
partial="$BACKUP_DIR/.allmywallet-$stamp.dump.age.partial"
counts_partial="$BACKUP_DIR/.allmywallet-$stamp.counts.age.partial"
counts_plain=$(mktemp)

# One psql session holds a REPEATABLE READ snapshot, hands it to pg_dump, then
# counts rows in that same snapshot — so the sidecar describes exactly what the
# dump contains, even with the worker writing meanwhile. The dump is pg_dump's
# stdout; psql's own output is silenced (\o /dev/null) except the counts, which
# go to stderr. `\!` takes no psql variables, hence \setenv. SHELL_ERROR is set
# by psql 16+ after `\!`; the division by zero turns it into ON_ERROR_STOP's
# non-zero exit.
dump_sql=$(
  cat <<SQL
\\set ON_ERROR_STOP on
\\o /dev/null
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS snapshot \\gset
\\setenv AMW_SNAPSHOT :snapshot
\\! pg_dump --format=custom --snapshot="\$AMW_SNAPSHOT" --username="\$POSTGRES_USER" --dbname="\$POSTGRES_DB"
\\if :SHELL_ERROR
SELECT 1 / 0 AS pg_dump_failed;
\\endif
\\o /dev/stderr
$ROW_COUNT_SQL
\\o /dev/null
COMMIT;
SQL
)

set +e
printf '%s\n' "$dump_sql" |
  personal_compose exec -T postgres \
    psql --no-psqlrc --quiet --no-align --tuples-only \
    --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --file=- \
    2>"$counts_plain" |
  "$AGE" --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$partial"
statuses=("${PIPESTATUS[@]}")
set -e

if [ "${statuses[1]}" -ne 0 ]; then
  fail "pg_dump did not complete (psql exit ${statuses[1]}): $(grep -v '|' "$counts_plain" | head -3 | tr '\n' ' ')"
fi
[ "${statuses[2]}" -eq 0 ] || fail "age could not encrypt the dump (exit ${statuses[2]})"
[ -s "$partial" ] || fail "the encrypted dump is empty"
grep -q '|' "$counts_plain" || fail "no row counts were captured alongside the dump"

grep '|' "$counts_plain" | sort |
  "$AGE" --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$counts_partial" ||
  fail "age could not encrypt the row-count sidecar"

mv "$partial" "$final"
mv "$counts_partial" "$counts_final"
partial=""
counts_partial=""
log "backup written: $final"

ops backup-record succeeded "$(basename "$final")" >/dev/null ||
  log "backup succeeded but could not be recorded in backup_runs"

# BR-021-19: prune only now, after success — and never on an unreadable count,
# since pruning on a guess is how the one surviving copy gets deleted.
if retain=$(ops backup-retain-count 2>/dev/null | tail -1); then
  prune_backups "$BACKUP_DIR" "$retain"
  log "kept the newest $retain backups"
else
  log "could not resolve backup.retain_count — nothing pruned"
fi
