#!/usr/bin/env bash
#
# #151, #171 — retry every recorded close gap B3's COTAHIST may now fill, on
# the personal instance, and rebuild snapshots from the earliest recovered day.
#
#   scripts/personal/backfill-gaps.sh
#
# The close job and worker-start catch-up already ask again for these on every
# run (#171), so this is only for recovering without waiting for either.
# Idempotent: a day that already has a close is not asked for again.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

# The installed image, the same way rebuild-snapshots.sh resolves it.
: "${IMAGE_TAG:=$(cat "$ALLMYWALLET_STATE_DIR/current-tag" 2>/dev/null || true)}"
[ -n "$IMAGE_TAG" ] || die "no installed image recorded in $ALLMYWALLET_STATE_DIR — run scripts/personal/init.sh first"
export IMAGE_TAG

personal_compose up -d --wait postgres
personal_compose run --rm --no-deps -T web node dist/ops.js backfill-gaps
