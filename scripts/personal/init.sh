#!/usr/bin/env bash
#
# SPEC-021 — initialise the personal production instance, once.
#
#   scripts/personal/init.sh
#
# First run writes a personal env file OUTSIDE the repository with generated
# database and auth secrets (BR-021-09), then stops so you can fill in the
# Google OAuth client, the backup drive and the age recipient. The second run:
#
#   1. refuses unless FileVault is on (BR-021-36);
#   2. pulls :latest and pins it by a local tag;
#   3. starts Postgres in its own Compose project on 127.0.0.1 (BR-021-06/10);
#   4. migrates with the image's own migrator (BR-021-13);
#   5. gives allmywallet_app its password;
#   6. writes the database-level marker and reads it back on a fresh session
#      (BR-021-07) — from here on tests, resets and seeds refuse this database;
#   7. takes the first backup and starts web and worker.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"

FDESETUP=${FDESETUP:-fdesetup}
UNAME=${UNAME:-uname}

# 1. BR-021-36: the laptop holds real holdings — and extracts, before import,
#    that still carry a CPF. Checked before anything is created.
[ "$("$UNAME" -s)" = "Darwin" ] || die "the personal instance is supported on macOS only (BR-021-36 checks FileVault)"
filevault=$("$FDESETUP" status 2>&1 || true)
case "$filevault" in
  *"FileVault is On"*) ;;
  *) die "refusing to initialise: full-disk encryption is off ('$filevault'). Turn FileVault on first (BR-021-36)." ;;
esac

for file in "$ALLMYWALLET_ENV_FILE" "$ALLMYWALLET_MIGRATOR_ENV_FILE"; do
  if inside_repo "$file"; then
    die "refusing $file: personal env files must live outside the repository (BR-021-09)"
  fi
done

# Once only. A second run would pull and migrate real data with no backup
# (BR-021-25) and overwrite last-known-good. Upgrades belong to start.sh.
if [ -s "$ALLMYWALLET_STATE_DIR/current-tag" ]; then
  die "already initialised ($ALLMYWALLET_STATE_DIR/current-tag exists) — start the instance with scripts/personal/start.sh"
fi

if [ ! -f "$ALLMYWALLET_ENV_FILE" ] || [ ! -f "$ALLMYWALLET_MIGRATOR_ENV_FILE" ]; then
  [ ! -f "$ALLMYWALLET_ENV_FILE" ] && [ ! -f "$ALLMYWALLET_MIGRATOR_ENV_FILE" ] ||
    die "only one of $ALLMYWALLET_ENV_FILE and $ALLMYWALLET_MIGRATOR_ENV_FILE exists — refusing to regenerate secrets over the other"
  mkdir -p "$(dirname "$ALLMYWALLET_ENV_FILE")" "$(dirname "$ALLMYWALLET_MIGRATOR_ENV_FILE")"
  umask 077
  postgres_password=$(openssl rand -hex 24)
  app_password=$(openssl rand -hex 24)
  auth_secret=$(openssl rand -base64 48 | tr -d '\n')
  sed \
    -e "s|__APP_PASSWORD__|$app_password|g" \
    -e "s|__AUTH_SECRET__|$auth_secret|g" \
    "$REPO_ROOT/scripts/personal/personal.env.example" >"$ALLMYWALLET_ENV_FILE"
  sed \
    -e "s|__POSTGRES_PASSWORD__|$postgres_password|g" \
    "$REPO_ROOT/scripts/personal/migrator.env.example" >"$ALLMYWALLET_MIGRATOR_ENV_FILE"
  chmod 600 "$ALLMYWALLET_ENV_FILE" "$ALLMYWALLET_MIGRATOR_ENV_FILE"
  log "wrote $ALLMYWALLET_ENV_FILE and $ALLMYWALLET_MIGRATOR_ENV_FILE with generated secrets."
  log "fill in AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, BACKUP_DIR, BACKUP_AGE_RECIPIENT and PGDATA_HOST_PATH in $ALLMYWALLET_ENV_FILE, then run this again."
  exit 0
fi

load_env
for name in AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET BACKUP_DIR BACKUP_AGE_RECIPIENT PGDATA_HOST_PATH POSTGRES_PASSWORD PERSONAL_DATABASE_MIGRATION_URL DATABASE_URL; do
  eval "value=\${$name:-}"
  # shellcheck disable=SC2154
  [ -n "$value" ] || die "$name is empty in $ALLMYWALLET_ENV_FILE"
done
command -v "$AGE" >/dev/null 2>&1 || die "age is not installed (brew install age)"

app_password=$(printf '%s' "$DATABASE_URL" | sed -E 's|^[^:]+://[^:]+:([^@]+)@.*$|\1|')
[ -n "$app_password" ] && [ "$app_password" != "$DATABASE_URL" ] || die "DATABASE_URL carries no password"

# 2. Pin the image by a local tag; start.sh only ever runs local tags.
"$DOCKER" pull "$IMAGE_REPO:latest"
image_id=$("$DOCKER" image inspect --format '{{.Id}}' "$IMAGE_REPO:latest")
image_id=${image_id#sha256:}
tag="local-$(printf '%s' "$image_id" | cut -c1-12)"
"$DOCKER" tag "$IMAGE_REPO:latest" "$IMAGE_REPO:$tag"
digest=$("$DOCKER" buildx imagetools inspect "$IMAGE_REPO:latest" 2>/dev/null | awk '/^Digest:/ { print $2; exit }' || true)
export IMAGE_TAG=$tag

# 3–4.
personal_compose up -d --wait postgres

psql_personal() {
  personal_compose exec -T postgres \
    psql --no-psqlrc -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"
}

# The state files can be lost while the database is not. A marked database
# already holds real data: never migrate it from here.
existing=$(psql_personal --tuples-only --no-align -c "SELECT current_setting('allmywallet.instance_role', true)")
[ "$existing" != "personal" ] || die "database $POSTGRES_DB is already marked personal — refusing to re-initialise it; use scripts/personal/start.sh"

personal_compose run --rm --no-deps -T \
  -e DATABASE_MIGRATION_URL="$PERSONAL_DATABASE_MIGRATION_URL" \
  web node dist/migrate.js

# 5. `0000_roles.sql` creates the role with no password, deliberately. The
#    statement is built by format(%L) server-side so the password is quoted by
#    Postgres, never by this script.
printf '%s\n' "SELECT format('ALTER ROLE allmywallet_app WITH LOGIN NOBYPASSRLS PASSWORD %L', :'app_password') \\gexec" |
  psql_personal --quiet -v app_password="$app_password" --file=- >/dev/null

# 6. The marker (BR-021-07, DL-021-13). Read back on a NEW session: ALTER
#    DATABASE … SET applies only to sessions started after it.
psql_personal --quiet -c "ALTER DATABASE \"$POSTGRES_DB\" SET allmywallet.instance_role = 'personal'"
marker=$(psql_personal --tuples-only --no-align -c "SELECT current_setting('allmywallet.instance_role', true)")
[ "$marker" = "personal" ] || die "the marker did not read back as 'personal' (got '$marker') — do not load data"
log "marked database $POSTGRES_DB as personal production; tests, resets and seeds now refuse it"

mkdir -p "$ALLMYWALLET_STATE_DIR"
printf '%s\n' "$tag" >"$ALLMYWALLET_STATE_DIR/current-tag"
printf '%s\n' "$tag" >"$ALLMYWALLET_STATE_DIR/last-good-tag"
printf '%s\n' "$digest" >"$ALLMYWALLET_STATE_DIR/current-digest"

# 7.
"$REPO_ROOT/scripts/personal/backup.sh" || log "the first backup failed — fix it before importing anything (see /api/health)"
personal_compose up -d web worker

port=${PERSONAL_WEB_PORT:-3100}
log "initialised. Open http://localhost:$port"
log "register this redirect URI on the Google OAuth client: http://localhost:$port/api/auth/callback/google"
log "from now on start the instance with scripts/personal/start.sh"
