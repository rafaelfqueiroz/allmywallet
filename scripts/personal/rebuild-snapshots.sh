#!/usr/bin/env bash
#
# SPEC-009 BR-009-17/18 — rebuild every tenant's valuation snapshots over their
# whole history, on the personal instance.
#
#   scripts/personal/rebuild-snapshots.sh
#
# Snapshots are derived from the ledger and the price history, so this is the
# repair for any report reading figures a data migration has since changed
# (#152 moved every Tesouro title's price series). `start.sh` runs the same
# command after every migration and the evening `valuation.snapshot` runs the
# same rebuild; this is the by-hand form.
set -euo pipefail

# shellcheck source=scripts/personal/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

# The installed image, the same way rebuild-positions.sh resolves it.
: "${IMAGE_TAG:=$(cat "$ALLMYWALLET_STATE_DIR/current-tag" 2>/dev/null || true)}"
[ -n "$IMAGE_TAG" ] || die "no installed image recorded in $ALLMYWALLET_STATE_DIR — run scripts/personal/init.sh first"
export IMAGE_TAG

personal_compose up -d --wait postgres
personal_compose run --rm --no-deps -T web node dist/ops.js rebuild-snapshots
