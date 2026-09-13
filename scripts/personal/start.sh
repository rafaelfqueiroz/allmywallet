#!/usr/bin/env bash
#
# SPEC-021 BR-021-23–BR-021-27 (AR-74) — start the personal instance, upgrading
# first when :latest has moved.
#
#   scripts/personal/start.sh
#
# Upgrade sequence, fixed: backup → pull → gated migration → start → health
# check → record last-known-good, or roll back to it.
#
#   - No migration without a backup that succeeded in this same run (BR-021-25).
#   - A failed migration leaves the current image running; drizzle applies
#     pending migrations in one transaction, so the schema is unchanged (BR-021-26).
#   - A failed health check restarts the last-known-good image on the NEW
#     schema — safe only because migrations are expand/contract (AR-69).
#   - Registry unreachable: start the current image. Start never blocks on the
#     network (BR-021-27).
#
# Images are run by a local tag, `local-<image id>`, never by `:latest`, so what
# "current" and "last-known-good" mean cannot move underneath a running start.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

BACKUP_SCRIPT=${BACKUP_SCRIPT:-$REPO_ROOT/scripts/personal/backup.sh}
REGISTRY_TIMEOUT=${REGISTRY_TIMEOUT:-15}
PULL_TIMEOUT=${PULL_TIMEOUT:-900}
HEALTH_ATTEMPTS=${HEALTH_ATTEMPTS:-30}
HEALTH_INTERVAL=${HEALTH_INTERVAL:-4}
WEB_PORT=${PERSONAL_WEB_PORT:-3100}

mkdir -p "$ALLMYWALLET_STATE_DIR"
read_state() { cat "$ALLMYWALLET_STATE_DIR/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" >"$ALLMYWALLET_STATE_DIR/$1"; }

current_tag=$(read_state current-tag)
last_good_tag=$(read_state last-good-tag)
current_digest=$(read_state current-digest)
failed_digest=$(read_state failed-digest)

[ -n "$current_tag" ] || die "no installed image recorded in $ALLMYWALLET_STATE_DIR — run scripts/personal/init.sh first"
[ -n "$last_good_tag" ] || last_good_tag=$current_tag

start_services() {
  log "starting image $1"
  IMAGE_TAG=$1 personal_compose up -d --wait postgres
  IMAGE_TAG=$1 personal_compose up -d web worker
}

healthy() {
  local attempt=1
  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if "$CURL" -fsS --max-time 5 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# BR-021-16: the first start of a (UTC) day takes a backup even when nothing
# upgrades. Its failure is recorded and shown (BR-021-20) but does not stop the
# instance starting — only a migration requires one.
daily_backup_if_due() {
  if ls "${BACKUP_DIR:-/nonexistent}"/allmywallet-"$(date -u +%Y%m%d)"T*.dump.age >/dev/null 2>&1; then
    return 0
  fi
  "$BACKUP_SCRIPT" || log "today's backup failed — see /api/health; the instance starts anyway"
}

remote_digest() {
  with_timeout "$REGISTRY_TIMEOUT" "$DOCKER" buildx imagetools inspect "$IMAGE_REPO:latest" 2>/dev/null |
    awk '/^Digest:/ { print $2; exit }'
}

digest=$(remote_digest || true)

if [ -z "$digest" ]; then
  log "registry unreachable — starting the current image without upgrading (BR-021-27)"
  start_services "$current_tag"
  daily_backup_if_due
  exit 0
fi

if [ "$digest" = "$current_digest" ]; then
  start_services "$current_tag"
  daily_backup_if_due
  exit 0
fi

if [ "$digest" = "$failed_digest" ]; then
  log "$IMAGE_REPO:latest ($digest) already failed its health check here — not retrying it; starting the current image"
  start_services "$current_tag"
  daily_backup_if_due
  exit 0
fi

log "upgrade available: $digest"

# 1. Backup — mandatory (BR-021-25). Postgres must be up to dump it.
IMAGE_TAG=$current_tag personal_compose up -d --wait postgres
if ! "$BACKUP_SCRIPT"; then
  log "backup failed — upgrade ABORTED before pulling; starting the current image"
  start_services "$current_tag"
  exit 1
fi

# 2. Pull.
if ! with_timeout "$PULL_TIMEOUT" "$DOCKER" pull "$IMAGE_REPO:latest"; then
  log "pull failed — starting the current image"
  start_services "$current_tag"
  exit 1
fi
new_id=$("$DOCKER" image inspect --format '{{.Id}}' "$IMAGE_REPO:latest")
new_id=${new_id#sha256:}
new_tag="local-$(printf '%s' "$new_id" | cut -c1-12)"
"$DOCKER" tag "$IMAGE_REPO:latest" "$IMAGE_REPO:$new_tag"

# 3. Gated migration, with the NEW image's migrator. The migration URL exists
#    only in this one container's environment, never in web's or worker's.
if ! IMAGE_TAG=$new_tag personal_compose run --rm --no-deps -T \
  -e DATABASE_MIGRATION_URL="$PERSONAL_DATABASE_MIGRATION_URL" \
  web node dist/migrate.js; then
  log "migration failed — no schema change was applied; the current image keeps running"
  start_services "$current_tag"
  exit 1
fi

# 4–5. Start the new image and let /api/health decide.
start_services "$new_tag"
if healthy; then
  write_state current-tag "$new_tag"
  write_state last-good-tag "$new_tag"
  write_state current-digest "$digest"
  log "upgraded to $new_tag; recorded as last-known-good"
  exit 0
fi

# 6. Roll back — the old image, on the new schema (AR-69).
log "health check failed — restarting last-known-good $last_good_tag on the migrated schema"
write_state failed-digest "$digest"
start_services "$last_good_tag"
if healthy; then
  log "rolled back to $last_good_tag, which is serving"
else
  log "last-known-good $last_good_tag is not healthy either — restore from backup (docs/runbooks/personal-instance.md)"
fi
exit 1
