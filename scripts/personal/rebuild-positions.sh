#!/usr/bin/env bash
#
# SPEC-007 BR-007-14 / DM-4 — replay every tenant's ledger into the position
# cache, on the personal instance.
#
#   scripts/personal/rebuild-positions.sh
#
# The ledger is authoritative and positions are derived, so this is the repair
# for any cache that disagrees with it — including the rows a data migration
# deletes because it cannot replay them in SQL (#136's institution merge).
# `start.sh` runs the same command after every migration; this is the by-hand
# form, and running it when nothing has drifted changes nothing.
#
# It reports how many tenants disagreed with the ledger before writing.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

# The installed image, the same way backup.sh resolves it. On an instance that
# rolled back to an image older than this command, the rebuild has already run
# with the new one — start.sh does it before the health check decides.
: "${IMAGE_TAG:=$(cat "$ALLMYWALLET_STATE_DIR/current-tag" 2>/dev/null || true)}"
[ -n "$IMAGE_TAG" ] || die "no installed image recorded in $ALLMYWALLET_STATE_DIR — run scripts/personal/init.sh first"
export IMAGE_TAG

personal_compose up -d --wait postgres
personal_compose run --rm --no-deps -T web node dist/ops.js rebuild-positions
