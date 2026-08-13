# ADR-001 — Docker image build and worker bundling

**Status:** Accepted
**Date:** 2026-08-13

## Context

SPEC-016 (#19) needed a working `deploy.yml`: build image → push to GHCR → SSH
to VPS → migrate → restart. `docker-compose.yml` already named an image
(`ghcr.io/rafaelfqueiroz/allmywallet:${IMAGE_TAG:-latest}`) and a worker
command (`node dist/worker.js`), from earlier work — but no `Dockerfile`
existed to produce either. AR-58 requires the image be built in CI, never on
the VPS, which made this a blocking gap for `deploy.yml`, not an optional
nice-to-have.

Next.js's `output: 'standalone'` (already set in `next.config.ts`) solves the
web half: it traces exactly what the web server imports and produces a
self-contained `.next/standalone` folder with its own pruned `node_modules`.
It does **not** trace `src/worker/index.ts` — nothing under `app/` imports it,
so pg-boss, pino and the rest of the worker's dependency graph are absent from
that trace.

## Options

1. **Run the worker with `tsx` in production**, same as `pnpm worker:dev`.
   Rejected: ships the whole TypeScript toolchain into a production image and
   transpiles on every container start — slower boot, larger image, and a
   class of "works with tsx, breaks compiled" bug the web half doesn't have.
2. **`tsc` compile the worker to `dist/`.** Rejected: the codebase imports
   everything through the `@/` path alias (DV-14); `tsc` does not rewrite
   those to relative paths at runtime, so the compiled output would not run
   under plain `node` without an additional loader (`tsc-alias`,
   `tsconfig-paths`) — another moving part for no real benefit over option 3.
3. **Bundle the worker with `esbuild`, `--packages=external`, ship a full
   `pnpm install --prod` `node_modules` alongside it.** Chosen.

## Decision

`package.json`'s `build:worker` script bundles `src/worker/index.ts` into a
single `dist/worker.js` with esbuild, resolving the `@/` alias and all
relative imports but leaving every npm package import unresolved
(`--packages=external`). The `Dockerfile`'s `prod-deps` stage runs `pnpm
install --frozen-lockfile --prod` independently of the build stage and copies
that `node_modules` into the final image for `dist/worker.js` to resolve
those externals against at runtime — a separate, complete production install,
not a subset of Next's web-server trace.

`esbuild` is added as a devDependency for this. It does not overlap any
canonical dependency in DEVELOPMENT.md §1 — nothing else in the project
bundles a Node entrypoint — so no existing choice is being duplicated.

## Consequences

**Easy:** the worker boots by running a plain, already-transpiled JS file —
no toolchain, no path-alias loader, fast startup. Adding a dependency to
`src/worker/` needs no `Dockerfile` change; it resolves through the shared
`node_modules` the same way the web half's standalone output does for its own
trace.

**Costs:** two separate `node_modules` installs happen in CI (`deps` for
building, `prod-deps` for the worker's runtime) — slightly slower image
builds, and the final image is larger than a single-trace image would be
(a full production `node_modules`, not the narrower one Next's tracer would
produce for the worker alone). Judged acceptable: AR-58 already put image
size outside the box's CPU/memory budget (images are pulled, not built, on
the VPS — AR-57's `mem_limit`s are what actually bound runtime footprint), and
CI build time is not a budget SPEC-016 sets.

**Forecloses:** nothing structural. If the worker's dependency footprint ever
diverges significantly from what a single shared `node_modules` conveniently
serves (unlikely at this scale), the two build stages already exist as the
seam to split further.
