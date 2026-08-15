#!/usr/bin/env bash
# Run the visual suite inside the pinned Playwright image (DL-C2).
#
# Screenshot baselines are platform-dependent: macOS and Linux rasterise fonts
# differently, so a baseline captured natively on a developer machine fails in
# CI forever, and fails in a way that reads as a real regression. The container
# is therefore the *only* sanctioned way to record or verify them — locally and
# in CI alike, which is the point.
#
#   pnpm test:visual:docker            # verify against the committed baselines
#   pnpm test:visual:docker --update   # re-record them after an intended change
set -euo pipefail

# Must match the @playwright/test version in package.json, or the browser build
# differs from the one the baselines were taken with.
PLAYWRIGHT_VERSION="$(node -p "require('./package.json').devDependencies['@playwright/test'].replace(/[^0-9.]/g,'')")"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

EXTRA_ARGS=()
if [[ "${1:-}" == "--update" ]]; then
  EXTRA_ARGS+=(--update-snapshots)
fi

# The app runs on the host, so the container needs a route back to it.
#
# Docker Desktop (macOS, Windows) provides `host.docker.internal` itself, and
# passing `--add-host=host.docker.internal:host-gateway` there *overrides* the
# working entry with one that does not route — the container then cannot reach
# the server at all. On Linux the opposite is true: the name does not exist
# unless that flag creates it. Hence the branch.
HOST_FLAGS=()
if [[ "$(uname -s)" == "Linux" ]]; then
  HOST_FLAGS+=(--add-host=host.docker.internal:host-gateway)
fi

DATABASE_URL="${DATABASE_URL:-postgresql://allmywallet_app:allmywallet@host.docker.internal:5432/allmywallet}"

# `set -u` treats an empty array expansion as unbound on bash 3.2, which is
# what macOS ships (see CLAUDE.md) — hence `+` rather than a bare expansion.
exec docker run --rm \
  ${HOST_FLAGS[@]+"${HOST_FLAGS[@]}"} \
  -v "$PWD:/work" \
  -w /work \
  -e CI \
  -e E2E_BASE_URL="${E2E_BASE_URL:-http://host.docker.internal:3000}" \
  -e DATABASE_URL="$DATABASE_URL" \
  "$IMAGE" \
  npx playwright test \
  --project=visual-desktop-light \
  --project=visual-desktop-dark \
  --project=visual-mobile-light \
  --project=visual-mobile-dark \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
