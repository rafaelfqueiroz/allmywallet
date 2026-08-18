# Development Guidelines

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Companion docs** | [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md) |

## 1. Canonical dependencies

One approved choice per concern. Adding a dependency that overlaps an existing one requires an ADR (§9).

| Concern | Package |
|---|---|
| Framework | `next` (App Router) |
| Data access | `drizzle-orm`, `drizzle-kit`, `pg` |
| Decimals | `decimal.js` |
| Auth | `next-auth@5` + `@auth/drizzle-adapter` |
| Validation | `zod` |
| Jobs | `pg-boss` |
| Styling | `tailwindcss` |
| Components | `shadcn/ui` (copied in, not a dependency) + `@radix-ui/*` |
| Charts | `recharts` |
| Tables | `@tanstack/react-table` |
| i18n | `next-intl` |
| Dates | `date-fns` + `@date-fns/tz` |
| Logging | `pino`, `pino-http` |
| Errors | `@sentry/nextjs` |
| Spreadsheets | `exceljs` (parsing B3 extracts) |
| Testing | `vitest`, `@testcontainers/postgresql`, `@playwright/test` |
| Lint/format | `eslint`, `prettier` |

**Not used:** moment.js (dead), lodash (native equivalents), any ORM other than Drizzle, Redis, an HTTP client wrapper (native `fetch`).

## 2. TypeScript conventions

| | |
|---|---|
| **DV-01** | `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. |
| **DV-02** | `any` is banned by lint. `unknown` plus a Zod parse is the escape hatch. A genuinely necessary `any` needs an inline justification comment. |
| **DV-03** | No non-null assertions (`!`). If a value can be absent, handle it. |
| **DV-04** | Type inference preferred over annotation, **except** at public boundaries — exported use cases, ports and server actions carry explicit signatures. |
| **DV-05** | Branded types for identifiers: `UserId`, `AssetId`, `WalletId`. Prevents passing an asset id where a wallet id belongs — a class of bug the compiler should catch, not a test. |
| **DV-06** | Domain types are immutable: `readonly` properties, no in-place mutation of entities. |
| **DV-07** | Zod schemas are the single source of truth for external input. Types are derived with `z.infer`, never declared twice. |

## 3. Naming and structure

| | |
|---|---|
| **DV-08** | Files `kebab-case.ts`; React components `PascalCase.tsx`. |
| **DV-09** | Directories are **domain concepts**, not technical layers: `core/valuation/`, not `core/services/`. |
| **DV-10** | One use case per file, named for what it does: `commit-import-batch.ts`, `compute-time-weighted-return.ts`. |
| **DV-11** | Ports named for the role, not the implementation: `QuoteProvider`, not `BrapiClient`. The adapter takes the concrete name. |
| **DV-12** | Test files sit next to their subject: `average-cost.ts` → `average-cost.test.ts`. |
| **DV-13** | Barrel files (`index.ts` re-exports) only at package-like boundaries. Not per directory — they obscure the import graph the lint boundaries depend on. |
| **DV-14** | Imports use the `@/` alias from `src/`. No `../../../`. |

## 4. Comments

| | |
|---|---|
| **DV-15** | Comment **why**, not what. Code says what it does. |
| **DV-16** | Any code implementing a spec rule cites it: `// SPEC-007 BR-007-03: sales never alter cost basis`. This is how a reader finds the reasoning without hunting. |
| **DV-17** | Non-obvious financial logic gets a worked example in a comment. `preço médio` after a bonificação is not self-evident six months later. |
| **DV-18** | No commented-out code. Git remembers it. |

## 5. Local setup

```bash
cp .env.example .env          # fill in Google OAuth credentials
docker compose up -d postgres # database only; app runs on the host
pnpm install
pnpm db:migrate
pnpm db:seed                  # demo tenant with synthetic data
pnpm dev                      # web on :3000
pnpm worker:dev               # worker, separate terminal
```

`pnpm` is the package manager; the lockfile is committed and CI uses `--frozen-lockfile`.

| Script | Does |
|---|---|
| `dev` / `worker:dev` | Next dev server / worker with reload |
| `build` / `start` / `worker` | Production build and both entrypoints |
| `db:generate` / `db:migrate` | Generate a migration from schema changes / apply pending |
| `db:seed` / `db:seed:reference` | Demo data / the SPEC-016 reference workload |
| `test` / `test:integration` / `test:e2e` | See [TESTING.md](TESTING.md) |
| `check` | typecheck + lint + format check — run before pushing |

## 6. Database workflow

Migrations are reviewed SQL, forward-only (AR-22–AR-23).

1. Edit the Drizzle schema in `src/db/schema/`.
2. `pnpm db:generate` — produces a timestamped SQL file.
3. **Read the generated SQL.** It is a draft, not an answer.
4. For a tenant-scoped table, hand-add the RLS policy **in the same file** (AR-14).
5. Commit schema change and migration together.

### Checklist for a new tenant-scoped table

- [ ] `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- [ ] `ENABLE` **and** `FORCE ROW LEVEL SECURITY`
- [ ] Policy `USING (user_id = current_setting('app.user_id')::uuid)` covering all operations
- [ ] Index on `user_id`, and on `(user_id, <common filter>)` where reports will query it
- [ ] `created_at` / `updated_at`
- [ ] Money columns `NUMERIC(20,8)`; dates `date`, timestamps `timestamptz`
- [ ] An isolation test exists — **CI blocks the merge without it** (SPEC-003 BR-003-04)

### Migrating production

No staging environment, by decision. The rehearsal is:

1. Restore the latest production backup locally.
2. Apply the migration against it and check timing and result.
3. Deploy — CI applies migrations as a gated pre-deploy step.

This is why the SPEC-016 restore drill matters twice over: it verifies the backup *and* provides the only realistic migration rehearsal available.

## 7. Git

**Trunk-based.** `main` is always deployable. Branches are short-lived — a day or two — and squash-merged.

| | |
|---|---|
| **DV-19** | Branches: `feat/spec-010-wallet-allocation`, `fix/spec-005-duplicate-detection`, `chore/...`, `docs/...`. Include the spec id where one applies. |
| **DV-20** | [Conventional Commits](https://www.conventionalcommits.org/): `feat(wallets): auto-increment allocation on buy`. |
| **DV-21** | The commit body names the spec rules implemented: `Implements SPEC-010 BR-010-10, BR-010-11.` The PR references the spec's board task so the checklist there stays current. |
| **DV-22** | Breaking schema or config changes carry `BREAKING CHANGE:` in the footer. |
| **DV-23** | Every change goes through a PR, self-reviewed if solo. The PR is where CI gates run and where the acceptance-criteria checklist is ticked. |
| **DV-24** | Never commit `.env`, real B3 extracts, or any file containing a real CPF or real holdings. `.gitignore` covers the obvious cases; the discipline covers the rest. |

DV-24 is not routine hygiene here — a real B3 extract is precisely the personal data SPEC-004 spent a whole section keeping out of the system.

### PR template

```markdown
## What
<!-- one or two sentences -->

## Spec
Implements SPEC-NNN — rules BR-NNN-nn, BR-NNN-nn
Spec page: https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-NNN-...
Closes #NN  <!-- the spec's board task; omit if this PR only partly satisfies it -->

## Acceptance criteria
<!-- copy the relevant checkboxes from the spec, tick what this PR satisfies -->
- [ ] ...

## Checks
- [ ] Tests cover the new behaviour
- [ ] Isolation test added, if a tenant-scoped table was introduced
- [ ] Migration reviewed by hand; RLS policy in the same file
- [ ] No personal data reaches logs or Sentry
- [ ] User-facing strings routed through i18n
```

## 8. CI/CD

**GitHub Actions.** Two workflows.

### On every PR — `ci.yml`

| Step | Blocking |
|---|---|
| Install (frozen lockfile) | ✅ |
| Typecheck | ✅ |
| Lint (incl. import-boundary rules, AR-05) | ✅ |
| Format check | ✅ |
| Unit tests | ✅ |
| Integration tests (Testcontainers Postgres) | ✅ |
| **Isolation tests** | ✅ (SPEC-003 BR-003-04) |
| Coverage: 100% calc modules, 80% overall | ✅ |
| Migration check — applies cleanly to an empty database | ✅ |
| Build | ✅ |
| E2E (Playwright) | ✅ |

### On merge to `main` — `deploy.yml`

```
build image  →  push to GHCR  →  SSH to VPS
                                   ├─ docker compose pull
                                   ├─ run migrations (gated, must succeed)
                                   ├─ docker compose up -d web worker
                                   └─ health check; roll back image on failure
```

| | |
|---|---|
| **DV-25** | Migrations run as a **separate, gated step before** containers restart. A failed migration aborts the deploy and leaves the running version untouched. |
| **DV-26** | Images are tagged with the commit SHA. Rollback is redeploying a previous SHA — which works only because migrations are forward-only and additive. |
| **DV-27** | Schema changes are **expand/contract**: add the new column, deploy code using both, backfill, drop the old one in a later release. Never a breaking change in a single deploy. |
| **DV-28** | Deploy secrets (SSH key, registry token) live in GitHub Actions secrets. Runtime secrets live in the VPS `.env`, never in CI. |

#### Deploy is gated until the VPS exists

**There is no deploy target yet.** No VPS is provisioned and the `production` environment holds none of the four secrets the deploy needs, so the `deploy` job is gated behind a `preflight` job and skips.

`build-image` still runs on every push — it is the only check that proves the Dockerfile still builds, which is worth having long before there is anywhere to send the image.

**To turn deploys on**, in this order:

1. Provision the VPS and lay down `/srv/allmywallet` with its Compose file and root-only `.env`.
2. Add `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` and `APP_HOST` to the repository's **`production` environment** (not repository-level secrets — the deploy job reads them through that environment).
3. Set the repository **variable** `DEPLOY_ENABLED` to `true`.

The variable is separate from the secrets on purpose. While it is unset, a missing secret is the expected state and the deploy skips quietly. Once it is set, a missing secret is a genuine fault and `preflight` **fails loudly** rather than skipping — because once a production box exists, a silently skipped deploy is worse than a failed one.

### Nightly — `nightly.yml`

Performance budgets against the seeded reference workload (SPEC-016, amended to advisory). Regressions raise an alert; they do not block merges.

### The minute budget is a real constraint

Actions on a private repository is **2.000 minutes/month**. By 2026-08-18 this project had spent about **1.687** of them, and it is worth knowing what buys what:

| Event | Billable |
|---|---|
| Opening a PR, or pushing another commit to one | **~14–20 min** — `ci.yml` fans out to eight parallel jobs |
| Merging to `main` | that again (CI runs on the push to `main`) plus ~8 min of `deploy.yml` |
| A nightly run | ~1 min |

**Volume is what spends it, not slow runs.** 150 runs in one week; the heaviest single day cost 635 minutes. `concurrency: cancel-in-progress: true` already stops a superseded push from finishing, so the remaining lever is pushing less: run the gate locally first (§5) and push once, rather than pushing to find out.

**Wall-clock duration is not cost.** A run's elapsed time in the Actions list includes queue wait, which is not billed — one CI run reads as 364 minutes there and cost 14. Anything reasoning about spend must sum the *jobs*, each rounded up to the whole minute.

| Script | Answers |
|---|---|
| `scripts/ci-watch.sh <pr> [ceiling]` | polls a PR's checks to completion, prints the result and what it cost, and **cancels** the run past the ceiling (default 20 min) so a hang cannot bill indefinitely |
| `scripts/ci-minutes.sh <run-id>` | what one run cost |
| `scripts/actions-usage.sh [YYYY-MM]` | month-to-date against the tier, broken down by workflow, job and day |

The billing REST endpoint needs an OAuth scope `gh` is not configured with here, and `/actions/runs/{id}/timing` reports zero on this repository, so all three reconstruct the figure from the jobs endpoint.

## 9. ADRs

Spec Decision Logs record **product** decisions. ADRs record **technical** decisions taken during implementation that the specs did not anticipate.

`docs/adr/NNN-short-title.md`:

```markdown
# ADR-NNN — Title
**Status:** Accepted | Superseded by ADR-NNN
**Date:** YYYY-MM-DD

## Context
What forced a decision.

## Options
What was considered, and what breaks under each.

## Decision
What was chosen.

## Consequences
What this makes easy, what it makes hard, what it forecloses.
```

| | |
|---|---|
| **DV-29** | Write an ADR when a choice is hard to reverse, contradicts a guideline here, or is one a future reader would otherwise reopen. |
| **DV-30** | Never edit a decided ADR. Supersede it with a new one and link both — the history is the value. |

## 9a. Runbooks

`docs/runbooks/` holds the procedures someone follows *while something is going
wrong*, which is the opposite audience to the rest of this directory: no
context, no time, and a strong pull towards doing the destructive thing first.
They are written as ordered steps, they say what not to do, and they state
their own known gaps rather than implying a readiness the project does not have.

| Runbook | When |
|---|---|
| [incident-response.md](../runbooks/incident-response.md) | Any unauthorised access, loss or disclosure of personal data. Carries the ANPD notification path and its 3-business-day deadline (SPEC-004 BR-004-19). |

## 10. Definition of done

A spec is complete when:

- [ ] Every acceptance criterion in the spec is ticked and demonstrable
- [ ] Every business rule is implemented or explicitly deferred with a note in the spec
- [ ] Tests meet the tiered coverage gate
- [ ] Isolation tests exist for any new tenant-scoped table
- [ ] Migrations reviewed, applied, and rehearsed against a restored backup
- [ ] No personal data in logs, errors or Sentry
- [ ] User-facing text in pt-BR through i18n
- [ ] Config values in the SPEC-002 registry, not hardcoded
- [ ] Cross-spec invariants still hold ([spec index](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs))
- [ ] ADR written for any technical decision the specs did not cover
