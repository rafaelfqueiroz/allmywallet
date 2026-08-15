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

exec node .next/standalone/server.js
