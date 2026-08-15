#!/usr/bin/env bash
# Build and serve the app the way production serves it.
#
# `next.config.ts` sets `output: 'standalone'` (AR-58 — the Docker image ships
# a self-contained server). `next start` cannot serve that build; it warns and
# carries on doing nothing useful, which is exactly how an E2E suite ends up
# green against a server that never started. The standalone bundle also does
# not copy the static assets or `public/` next to itself — Next leaves that to
# whoever deploys it, and the Dockerfile does it there.
set -euo pipefail

pnpm build

cp -r .next/static .next/standalone/.next/static
if [[ -d public ]]; then
  cp -r public .next/standalone/public
fi

# The kitchen-sink route the visual suite photographs is off unless asked for.
# This server is only ever started by the test suites, so it is the one place
# that asks. Nothing that deploys sets it.
export ALLOW_DEV_ROUTES=true

# Next's standalone server binds to `process.env.HOSTNAME`, and inside a
# container HOSTNAME is the container id. It then listens on the container's own
# address and `localhost:3000` answers nothing — which is exactly how the visual
# job timed out after five minutes with no output at all. Pinning it is the
# documented fix and is harmless outside a container.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"

exec node .next/standalone/server.js
