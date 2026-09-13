#!/usr/bin/env bash
#
# SPEC-021 BR-021-21 — restore drill, into a DISPOSABLE instance.
#
#   scripts/personal/restore-drill.sh <age identity file> [dump.age]
#
# Decrypts the newest backup (or the one named) into a throwaway Postgres
# container with no network, restores it, and compares every table's row count
# with the counts taken inside the dump's own snapshot. It never connects to the
# personal database. Exit 0 only when every count matches.
#
# The identity file is the private half of BACKUP_AGE_RECIPIENT. It should not
# normally live on this laptop; mount it for the drill and remove it after.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

identity=${1:-}
[ -n "$identity" ] && [ -f "$identity" ] || die "usage: $0 <age identity file> [dump.age]"

dump=${2:-$(backup_files_newest_first "$BACKUP_DIR" | head -1)}
[ -n "$dump" ] && [ -f "$dump" ] || die "no backup found in $BACKUP_DIR"
counts="${dump%.dump.age}.counts.age"
[ -f "$counts" ] || die "no row-count sidecar next to $dump"

drill="amw-restore-drill-$$"
expected=$(mktemp)
actual=$(mktemp)
cleanup() {
  "$DOCKER" rm -f "$drill" >/dev/null 2>&1 || true
  rm -f "$expected" "$actual"
}
trap cleanup EXIT

log "drilling $(basename "$dump") into disposable container $drill"
"$DOCKER" run -d --name "$drill" --network none \
  -e POSTGRES_USER=allmywallet_migrator -e POSTGRES_PASSWORD=restore-drill -e POSTGRES_DB=allmywallet \
  postgres:17-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  if "$DOCKER" exec "$drill" pg_isready -U allmywallet_migrator -d allmywallet >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || die "the disposable Postgres never became ready"

drill_psql() {
  "$DOCKER" exec -i "$drill" psql --no-psqlrc -v ON_ERROR_STOP=1 -U allmywallet_migrator -d allmywallet "$@"
}

# pg_dump carries no roles; the grants and policies in the dump reference this one.
drill_psql --quiet -c "CREATE ROLE allmywallet_app LOGIN NOBYPASSRLS" >/dev/null

"$AGE" --decrypt --identity "$identity" "$dump" |
  "$DOCKER" exec -i "$drill" pg_restore --exit-on-error -U allmywallet_migrator -d allmywallet

"$AGE" --decrypt --identity "$identity" "$counts" | sort >"$expected"
printf '%s\n' "$ROW_COUNT_SQL" | drill_psql --quiet --tuples-only --no-align --file=- | grep '|' | sort >"$actual"

if diff -u "$expected" "$actual"; then
  log "restore drill PASSED: $(wc -l <"$expected" | tr -d ' ') tables, every row count matches"
else
  die "restore drill FAILED: row counts differ (expected at backup time, left; restored, right)"
fi
