#!/usr/bin/env bash
#
# #151 — retry every recorded close gap brapi may now fill, on the personal
# instance, and rebuild snapshots from the earliest recovered day.
#
#   scripts/personal/backfill-gaps.sh
#
# Worker-start catch-up only looks forward from the newest captured close, so
# days refused while other assets were being captured (a missing BRAPI_TOKEN
# quoted three test tickers and nothing else) are never revisited on their
# own. Idempotent: a day that already has a close is not asked for again.
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
