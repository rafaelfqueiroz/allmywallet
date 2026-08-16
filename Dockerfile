# AR-58: images are built in CI, never on the VPS — the box only pulls and
# runs (docker-compose.yml's `web`/`worker` services share this one image,
# ARCHITECTURE §2's "same image, different command").
#
# DEVIATION (SPEC-016 #19, for the Decision log / ADR-001): no Dockerfile
# existed before this task, despite docker-compose.yml already referencing
# `ghcr.io/rafaelfqueiroz/allmywallet:...` and the worker's `node
# dist/worker.js` command. This is the file that makes both real. See
# docs/adr/001-docker-image-and-worker-bundling.md for the reasoning behind
# the worker's separate esbuild bundle rather than reusing Next's standalone
# trace (which only traces what the *web* server actually imports).

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# --- dependencies (full, incl. dev — needed to build) ------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- production-only dependencies (for the worker's `--packages=external` bundle) ---
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- build -------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# SPEC-001: next build's page-data collection for /signin runs src/auth.ts's
# requireAuthEnv() (AR-40/AR-41), which needs syntactically valid values, not
# real ones — no real OAuth flow runs during a build. Mirrors ci.yml's build job.
ENV DATABASE_URL=postgresql://allmywallet_app:allmywallet@localhost:5432/allmywallet_build_placeholder
ENV AUTH_SECRET=docker-build-placeholder-secret-not-real-00000
ENV AUTH_GOOGLE_ID=docker-build-placeholder-google-client-id
ENV AUTH_GOOGLE_SECRET=docker-build-placeholder-google-client-secret
# #42: `next build` runs with NODE_ENV=production, so src/lib/trusted-host.ts's
# assertion applies to the build too. A build serves no traffic and has no
# canonical origin, so header trust is the honest answer here — and it is
# confined to this stage: `runner` below starts from `base`, so this ENV never
# reaches the shipped image. The deployed container is pinned by AUTH_URL,
# which docker-compose.yml sets from DOMAIN.
ENV AUTH_TRUST_HOST=true
RUN pnpm build
RUN pnpm build:worker

# --- runtime -------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S allmywallet && adduser -S allmywallet -G allmywallet

# Next.js standalone output (next.config.ts's `output: 'standalone'`) is
# self-contained — its own pruned node_modules for exactly what the web
# server imports.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Wildcarded rather than a plain path — no public/ directory exists in this
# repo yet (no static assets committed), and a literal COPY of a missing path
# fails the build; a glob with no match is a silent no-op instead.
COPY --from=builder /app/public* ./public

# The worker's bundle plus a full production `node_modules` — esbuild's
# `--packages=external` (package.json's build:worker script) leaves every
# `import`/`require` of an npm package unresolved in dist/worker.js on
# purpose, so it needs the real node_modules at runtime rather than Next's
# web-server-scoped trace (see the ADR).
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
# Not copying the root package.json over Next's own standalone-generated one
# (already present under ./ from the first COPY above) — it already carries
# `"type": "module"`, which is what makes Node treat dist/worker.js as ESM
# (the nearest package.json going up from a file governs its module type).

USER allmywallet
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# No default CMD — docker-compose.yml's `web`/`worker` services each specify
# their own (`node server.js` / `node dist/worker.js`), which is the entire
# point of the two-command-one-image split (ARCHITECTURE §2).
