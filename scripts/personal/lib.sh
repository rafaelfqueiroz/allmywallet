# shellcheck shell=bash
#
# SPEC-021 — shared helpers for the personal production scripts. Sourced, never
# run. Written for bash 3.2 (macOS's /bin/bash): no mapfile, no coproc, no
# associative arrays.
#
# Every external command is reached through a variable (DOCKER, AGE, CURL,
# FDESETUP) so tests/scripts/ can put a stub in its place and assert what the
# script *did* — the only honest way to test "a failed backup never reaches the
# migration" without failing a real backup.

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# BR-021-09 (AR-75): outside the working tree by default, and refused inside it.
: "${ALLMYWALLET_ENV_FILE:=$HOME/.config/allmywallet/personal.env}"
: "${ALLMYWALLET_STATE_DIR:=$HOME/.local/state/allmywallet}"
export ALLMYWALLET_ENV_FILE ALLMYWALLET_STATE_DIR

IMAGE_REPO=${IMAGE_REPO:-ghcr.io/rafaelfqueiroz/allmywallet}
DOCKER=${DOCKER:-docker}
AGE=${AGE:-age}
CURL=${CURL:-curl}

log() { echo "allmywallet-personal: $*" >&2; }
die() {
  log "$*"
  exit 1
}

absolute_path() {
  if [ -d "$1" ]; then
    (cd "$1" && pwd -P)
  else
    echo "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")"
  fi
}

# True when $1 lies inside the repository working tree.
inside_repo() {
  case "$(absolute_path "$1")/" in
    "$(cd "$REPO_ROOT" && pwd -P)"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The device a path's filesystem lives on — `stat -f` on macOS, `stat -c` on Linux.
device_of() {
  stat -f %d "$1" 2>/dev/null || stat -c %d "$1"
}

# BR-021-18: true when both paths sit on the same volume.
same_volume() {
  [ "$(device_of "$1")" = "$(device_of "$2")" ]
}

load_env() {
  [ -f "$ALLMYWALLET_ENV_FILE" ] || die "no personal env file at $ALLMYWALLET_ENV_FILE — run scripts/personal/init.sh first"
  if inside_repo "$ALLMYWALLET_ENV_FILE"; then
    die "refusing $ALLMYWALLET_ENV_FILE: the personal env file must live outside the repository (BR-021-09)"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ALLMYWALLET_ENV_FILE"
  set +a
}

# The one Compose invocation every personal script uses (BR-021-12).
personal_compose() {
  "$DOCKER" compose \
    -f "$REPO_ROOT/docker-compose.yml" \
    -f "$REPO_ROOT/docker-compose.personal.yml" \
    --env-file "$ALLMYWALLET_ENV_FILE" \
    --profile app \
    "$@"
}

# Runs "$@" with a deadline; macOS ships no `timeout`. BR-021-27: nothing a
# start waits on over the network may wait forever.
with_timeout() {
  local seconds=$1
  shift
  "$@" &
  local pid=$!
  # Detached from stdout/stderr: the watcher's `sleep` outlives the watcher
  # when it is killed, and an inherited pipe would hold the caller's output
  # open — and the caller waiting — for the whole deadline.
  (
    sleep "$seconds"
    kill -TERM "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local watcher=$!
  local status=0
  wait "$pid" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$status"
}

backup_files_newest_first() {
  ls -1 "$1"/allmywallet-*.dump.age 2>/dev/null | sort -r
}

# BR-021-19: keeps the newest $2 dumps (and their row-count sidecars) in $1.
# Callers run this only after a backup has succeeded.
prune_backups() {
  local dir=$1 keep=$2 index=0 file
  case "$keep" in
    '' | *[!0-9]*) die "prune_backups: retain count must be a positive integer, got '$keep'" ;;
  esac
  [ "$keep" -ge 1 ] || die "prune_backups: retain count must be at least 1"
  backup_files_newest_first "$dir" | while IFS= read -r file; do
    index=$((index + 1))
    if [ "$index" -gt "$keep" ]; then
      rm -f "$file" "${file%.dump.age}.counts.age"
    fi
  done
}

# The row count of every public table, one `table|count` per line, sorted.
# Shared by backup.sh (inside the dump's own snapshot) and restore-drill.sh.
ROW_COUNT_SQL="SELECT format('SELECT %L || ''|'' || count(*) FROM public.%I', tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \\gexec"
