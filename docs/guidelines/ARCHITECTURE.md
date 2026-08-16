# Architecture Guidelines

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Applies to** | All specs in [docs/specs/](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs) |
| **Companion docs** | [DEVELOPMENT.md](DEVELOPMENT.md), [TESTING.md](TESTING.md) |

## 1. Stack

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict` |
| Framework | Next.js (App Router) |
| Database | PostgreSQL 17+ |
| Data access | Drizzle ORM + `drizzle-kit` |
| Decimal arithmetic | `decimal.js` over `NUMERIC` |
| Auth | Auth.js v5, Google provider only |
| Validation | Zod |
| Jobs & scheduling | pg-boss (Postgres-backed) |
| UI | Tailwind + shadcn/ui + Recharts + TanStack Table |
| i18n | next-intl, pt-BR |
| Logging | Pino (structured JSON) |
| Errors | Sentry |
| Hosting | Single VPS (São Paulo region), Docker Compose |
| TLS / reverse proxy | Caddy |

## 2. Runtime topology

One VPS, four containers from one Compose file. Two of them run the **same image** with different commands — the worker is not a separate service, it is a second entrypoint into the same codebase.

```
                    ┌──────────── VPS (São Paulo) ────────────┐
   internet ──TLS──▶ │ caddy ──▶ web    (next start)          │
                    │           worker (node dist/worker.js)  │
                    │              │         │                │
                    │              └────┬────┘                │
                    │                postgres                 │
                    └─────────────────────────────────────────┘
```

| Container | Role |
|---|---|
| `caddy` | Reverse proxy, automatic TLS |
| `web` | Next.js server — user requests, RSC, server actions |
| `worker` | pg-boss consumer — scheduled jobs, queued work |
| `postgres` | Database, plus the pg-boss job tables |

**Why the worker exists.** SPEC-008 polls quotes on a schedule through market hours; SPEC-005 commits 10,000-row imports that can exceed any request timeout. Neither fits inside a request/response cycle. The split follows a real runtime constraint, not a layering preference.

## 3. Layering — hexagonal, pragmatically applied

```
src/
  core/                    # domain + use cases. Imports NOTHING from next/*, drizzle, or any adapter.
    ledger/                #   entities, value objects, use cases, port interfaces
    positions/
    valuation/
    quotes/
    wallets/
    reporting/
    ingestion/
    shared/                #   Money, Result, domain errors, date/calendar helpers
  adapters/                # implementations of core's ports
    db/                    #   Drizzle repositories
    quotes/                #   brapi client, Tesouro CSV, BCB SGS
    ingestion/             #   xlsx parsers (Movimentação, Negociação, Posição)
    email/
  db/                      # schema, migrations, RLS policies, tenant transaction helper
  app/                     # Next.js App Router — thin. Parses input, calls a use case, renders.
  worker/                  # pg-boss entrypoint: schedule registration + handlers
  config/                  # SPEC-002 registry, resolution, startup validation
  i18n/                    # message catalogues
```

### The rules

| | |
|---|---|
| **AR-01** | `core/` imports nothing from `next/*`, `drizzle-orm`, `pg`, or `adapters/`. It is plain TypeScript, runnable without a database. |
| **AR-02** | Ports (interfaces) are declared **in `core/`**, next to the use case that needs them. Adapters implement them and are injected at the composition root. |
| **AR-03** | A port exists only where a seam is **real** — a second implementation exists, is planned, or the boundary is external. Not one port per entity. |
| **AR-04** | `app/` and `worker/` are both thin entrypoints. Neither contains business rules. Anything either one does that the other might need belongs in `core/`. |
| **AR-05** | Boundaries are enforced by ESLint `import/no-restricted-paths`, so violations fail CI rather than depending on review. |

### Ports that are real

These come straight from the specs and are not speculative:

| Port | Implementations | Spec |
|---|---|---|
| `IngestionPort` | xlsx parsers, manual entry, (v2) Open Finance adapter | SPEC-005 BR-005-08 |
| `QuoteProvider` | brapi free tier; swappable tier or vendor | SPEC-008 BR-008-26 |
| `IndexSeriesProvider` | BCB SGS | SPEC-008 |
| `Clock` / `TradingCalendar` | real, and a controllable fake for tests | SPEC-008 BR-008-07 |
| Repositories | Drizzle | — |

`Clock` and `TradingCalendar` earn their place because SPEC-008's entire behaviour is time-dependent — "make no request outside the session" is untestable without controlling what time it is.

## 4. Money and precision

CR-2 forbids floating point. This is the most consequential technical rule in the project: a `number` reaching a money field corrupts data silently and unfixably.

| | |
|---|---|
| **AR-06** | Money and quantities are `NUMERIC(20,8)` in Postgres and `Decimal` (decimal.js) in the domain. |
| **AR-07** | A Drizzle **custom type** parses `NUMERIC` to `Decimal` on read and serialises on write. Money never exists as a JS `number` at any point in its lifecycle. |
| **AR-08** | A `Money` value object in `core/shared/` wraps `Decimal` and exposes only safe operations. Domain code does not use `Decimal` directly. |
| **AR-09** | Rounding happens **only at display**, in the i18n formatter. No rounding in the domain, ever (CR-3). |
| **AR-10** | Never `JSON.stringify` a `Decimal` into a job payload or server-action response — it becomes a float. Serialise to string explicitly at the boundary. |

AR-10 is the one that will actually bite: pg-boss payloads and server action return values are both JSON.

## 5. Tenant isolation

RLS is the enforcement floor (SPEC-003). The implementation has three parts that must all hold.

**Two database roles.**

| Role | Used by | Properties |
|---|---|---|
| `allmywallet_migrator` | migrations only | table owner, DDL rights |
| `allmywallet_app` | web + worker at runtime | no ownership, **no `BYPASSRLS`** |

The split matters: a table owner bypasses its own RLS policies unless `FORCE ROW LEVEL SECURITY` is set. Both mechanisms are used — `FORCE` on every tenant table, and an app role that is not the owner.

**A tenant transaction helper.** Every tenant-scoped operation runs inside one:

```ts
// src/db/tenant.ts
export async function withTenant<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`); // true = transaction-scoped
    return fn(tx);
  });
}
```

| | |
|---|---|
| **AR-11** | Every tenant-scoped query runs inside `withTenant`. A query outside it must fail — the policy references a setting that will not exist. |
| **AR-12** | `userId` comes from the verified Auth.js session, never from a request parameter (SPEC-003 BR-003-04). |
| **AR-13** | `set_config(..., true)` is transaction-scoped, so a pooled connection cannot carry tenant context into the next request. Session-level `SET` is prohibited. |
| **AR-14** | The RLS policy for a table is written **in the same migration** that creates the table. A migration adding a tenant table without its policy fails review. |
| **AR-15** | Shared reference tables (`assets`, `institutions`, `price_quotes`, `latest_quotes`, `index_series`) hold no personal data and are exempt by explicit declaration (SPEC-003 BR-003-06). |

**Worker caveat.** Background jobs have no session. A job touching tenant data carries its `userId` in the payload and calls `withTenant` explicitly. Jobs touching only shared reference tables (quote polling) run without tenant context — and per SPEC-003 BR-003-07 that is the only cross-tenant work permitted.

## 6. Background jobs

pg-boss owns scheduling and queueing. It uses the Postgres already present — no Redis.

| | |
|---|---|
| **AR-16** | **Only the worker registers schedules.** The web process may enqueue (`boss.send`) but never schedules or consumes. This keeps cron ownership in exactly one place. |
| **AR-17** | Cron expressions are registered with `tz: 'America/Sao_Paulo'`. Market hours are local, and getting this wrong silently shifts every poll by three hours. |
| **AR-18** | The trading-calendar check lives in the **handler**, not the cron expression. Cron cannot express B3 holidays or half-sessions, so the handler exits early on a non-trading day (SPEC-008 BR-008-06). |
| **AR-19** | Handlers are idempotent. pg-boss retries, and a retried quote poll or accrual must not double-apply. |
| **AR-20** | Retry policy, backoff and dead-lettering are configured per queue, not defaulted. A failed job must end somewhere visible (SPEC-016 BR-016-13). |
| **AR-21** | Job payloads carry **ids, not objects** — `{ batchId }`, not a serialised batch. Payloads are JSON and would destroy `Decimal` precision (AR-10). |

Queues in scope: `quotes.poll`, `quotes.close-capture`, `tesouro.sync`, `bcb.sync`, `import.commit`, `valuation.snapshot`, `fixedincome.accrue`, `budget.check`.

## 7. Database conventions

| | |
|---|---|
| **AR-22** | Migrations are **SQL files**, generated by `drizzle-kit`, reviewed and committed. Never `drizzle-kit push` against any database with real data. |
| **AR-23** | **Forward-only.** No down migrations — they are rarely correct and never exercised. A mistake is fixed by a new migration. |
| **AR-24** | `snake_case` tables and columns; plural table names. |
| **AR-25** | UUIDv7 primary keys — `uuidv7()` natively on Postgres 18+, otherwise generated in application code. Time-ordered, so they index well, unlike UUIDv4. |
| **AR-26** | Every table has `created_at` and `updated_at` (`timestamptz`). Every tenant table has `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`. |
| **AR-27** | The `ON DELETE CASCADE` in AR-26 is load-bearing: it is what makes SPEC-004's account deletion complete and verifiable. |
| **AR-28** | Money/quantity columns are `NUMERIC(20,8)`. Never `float`, `double precision`, or `money`. |
| **AR-29** | All timestamps are `timestamptz` stored in UTC. Business dates that are genuinely dates — trade date, pay date, position date — are `date`, not timestamps. |
| **AR-30** | Enum-like columns use `text` + a `CHECK` constraint, not Postgres `ENUM` types (which are painful to alter). |

**AR-29 matters more than it looks.** A trade on 2026-03-15 in São Paulo is that date regardless of timezone. Storing it as a timestamp invites an off-by-one that shifts transactions across period boundaries and quietly corrupts every report.

## 8. Application surface

| | |
|---|---|
| **AR-31** | Reads: React Server Components call use cases in `core/` directly. No internal HTTP hop. |
| **AR-32** | Mutations: server actions. Each validates input with Zod at the boundary, resolves the session, and calls exactly one use case. |
| **AR-33** | Route handlers only for things server actions cannot do: CSV export streams, health checks, Auth.js callbacks. |
| **AR-34** | Server actions return a serialisable `Result`, never a thrown domain error (see §9). |
| **AR-35** | No business logic in components. A component that computes a portfolio figure is a defect — that belongs in `core/reporting/`. |

## 9. Errors and Result

Two categories, handled differently.

| Category | Handling |
|---|---|
| **Expected domain outcomes** — selling more than held, an unparseable file, a rate that cannot be read | Returned as `Result<T, DomainError>`. Not exceptional; the UI must render them meaningfully. |
| **Genuine faults** — database unreachable, bug, provider 500 | Thrown. Caught at the boundary, logged, reported to Sentry, surfaced as a generic failure. |

| | |
|---|---|
| **AR-36** | Use cases return `Result<T, DomainError>`. They do not throw for expected outcomes. |
| **AR-37** | `DomainError` carries a **stable code** plus structured context — `{ code: 'INSUFFICIENT_QUANTITY', held, requested, date }` — never a pre-formatted user string. |
| **AR-38** | User-facing text is produced from the code by the i18n layer. This is what lets SPEC-005 BR-005-05's "specific, actionable error" be actionable in pt-BR. |
| **AR-39** | Error context must never carry personal data into logs or Sentry (SPEC-004 BR-004-04). Codes and structural facts only. |

## 10. Configuration

SPEC-002 is implemented as a typed registry in `src/config/`.

| | |
|---|---|
| **AR-40** | Each key declares a Zod schema, a default, and which levels may set it. Validation runs **at process start**; an invalid value exits non-zero rather than falling back (SPEC-002 BR-002-04). |
| **AR-41** | Both `web` and `worker` validate on boot. A bad value must not start half the system. |
| **AR-42** | Operator-set config and system-adjusted runtime state (SPEC-008's cadence degradation) live in **separate tables**, never merged (SPEC-002 BR-002-05). |
| **AR-43** | Secrets are read from environment only and are excluded from the effective-config view, logs and Sentry. |

## 11. Internationalisation

| | |
|---|---|
| **AR-44** | All user-facing text goes through next-intl. **No string literals in components.** |
| **AR-45** | pt-BR is the only locale in v1. The catalogue exists so SPEC-016 BR-016-17's vocabulary requirement is checkable, not because a second language is planned. |
| **AR-46** | Market vocabulary stays Portuguese: *proventos*, *preço médio*, *patrimônio*, *rentabilidade*. Do not translate to English equivalents Brazilian investors do not use. |
| **AR-47** | Currency and date formatting live in shared formatters — `R$ 1.234,56`, `dd/mm/yyyy`. Never inline `toLocaleString`. |

## 12. Observability — phased

Full instrumentation on day one would exceed the app itself in moving parts. Phased by when there is something worth watching.

| Phase | Adds |
|---|---|
| **M0** | Pino structured JSON logs with rotation; Sentry; Uptime Kuma against the health endpoint |
| **M4** | OpenTelemetry + Prometheus + Grafana — once the job queue and quote budget exist, which is what actually needs graphing |

| | |
|---|---|
| **AR-48** | Sentry must be configured to scrub request bodies, headers and query strings. It captures them by default, which would violate SPEC-004 BR-004-04 on day one. |
| **AR-49** | Logs carry a request/job correlation id and, where relevant, a **hashed** user id — never an email, name or CPF. |
| **AR-50** | A `/api/health` endpoint reports database reachability, worker liveness and last successful quote sync. Uptime Kuma polls it for the 99% target. |
| **AR-51** | Metrics that matter when M4 lands: provider request budget consumed, job queue depth and failure rate, report render p95, import duration. |

## 13. Security posture

Mostly inherited from SPEC-003; the architectural consequences:

| | |
|---|---|
| **AR-52** | No credential of any kind — password, B3, broker, bank — is collected, transmitted or stored. Firm boundary. |
| **AR-53** | Uploaded spreadsheets are parsed **in the worker**, not the web process: resource-limited, size-capped, and unable to take the user-facing app down. |
| **AR-54** | CPF is stripped in the parser adapter, before the normalized record crosses into `core/`. The domain must never see one (SPEC-004 BR-004-02). |
| **AR-55** | CSV export neutralises cells starting `=`, `+`, `-`, `@` (SPEC-003 BR-003-13). |
| **AR-56** | Caddy terminates TLS and sets security headers; CSP is defined explicitly, not defaulted. |

## 14. Host sizing

**Hostinger KVM 2** — 2 vCPU, 8 GB RAM, 100 GB NVMe, **São Paulo region** (required: it is the latency the users actually experience).

Memory budget with the full M4 observability stack running:

| Service | RAM |
|---|---|
| postgres | 1.0–1.5 GB |
| web | 0.5–1.0 GB |
| worker | 0.3–0.5 GB |
| caddy | 50 MB |
| prometheus | 0.5–1.0 GB |
| grafana | 0.25–0.4 GB |
| otel-collector | 0.1–0.2 GB |
| uptime-kuma | 150 MB |
| OS + Docker | 0.5–1.0 GB |
| **Total** | **~4–6 GB** |

| | |
|---|---|
| **AR-57** | Every Compose service declares an explicit `mem_limit`. Unbounded Prometheus growth OOM-killing Postgres is the classic single-box failure, and it is the specific risk that makes 8 GB adequate rather than merely arithmetically sufficient. |
| **AR-58** | Images are built in CI, never on the VPS. This is what keeps 2 vCPU viable — the box only pulls and runs. |
| **AR-59** | Upgrade trigger: sustained memory use above 6 GB, or Postgres `shared_buffers` needing more than 1 GB. Upgrade in place rather than provisioning ahead — KVM 4 renews at roughly double KVM 2. |

4 GB (KVM 1) is deliberately rejected: it carries M0–M3 and then forces a migration under pressure exactly when the worker and metrics arrive.

## 15. Backup and restore

> **Deferred — tracked as [BL-001](https://github.com/rafaelfqueiroz/allmywallet/issues/1).** Not built yet; there is no production data to lose. **Trigger: before the first non-test user account exists.** The requirements below are decided and stand as written for when it is built.

The dump is the most sensitive artifact the system produces — every user's complete financial position in one file.

**Frequency: weekly** (SPEC-016 BR-016-09, DL-016-08). This sets the recovery point objective at **up to 7 days of data loss** — accepted deliberately at current scale. Note what a lost week actually costs: the B3 extract can be re-imported, but manual entries, wallet structure, allocations and reconciliation adjustments exist only here.

Hostinger includes weekly backups of its own. They now match this policy's *frequency*, but they are still not restore-tested, not verified against SPEC-004 BR-004-16, and not under your control — a fortunate second copy, not the plan.

**Target:** S3-compatible object storage, **Cloudflare R2** — decided (zero egress, which directly serves the quarterly restore drill).

| | |
|---|---|
| **AR-60** | **Weekly** `pg_dump` (custom format, compressed), encrypted client-side with `age` before upload. Provider-side encryption alone is not sufficient for this artifact. |
| **AR-61** | The VPS holds **write-only** credentials. A compromised server must not be able to read or delete backup history. Restore uses separate credentials held outside the box. |
| **AR-62** | Retention is a **bucket lifecycle rule** expiring objects at 30 days — not a cron job, not a manual chore. This is also what satisfies SPEC-004 BR-004-16 (deleted-user data purged from backups within one cycle). |
| **AR-63** | Object lock for the retention window, so backups cannot be deleted early by a compromised credential. |
| **AR-64** | A backup that fails to upload raises an alert (SPEC-016 BR-016-13). A silent backup failure is indistinguishable from having no backups. |
| **AR-65** | The quarterly restore drill (SPEC-016 BR-016-09/10) restores to a local Postgres, verifies row counts and confirms deleted-user data is absent. It doubles as the migration rehearsal, since there is no staging environment. **Until BL-001 ships, migrations rehearse against seeded data instead — which has neither production's shape nor its volume.** |
| **AR-66** | The storage provider is listed in the LGPD subprocessor inventory with a DPA in place (SPEC-004 BR-004-18). R2 is outside Brazil, making the backup an international transfer under Art. 33 — permitted with standard contractual clauses, and it must be stated in the privacy policy. |

**Sizing** — roughly 25 MB uncompressed per user (`import_rows` provenance dominates at ~20 MB), plus ~25 MB shared quote history, compressing about 5:1. At 1,000 users that is ~1.2 GB per dump and ~36 GB retained: a few reais per month. Cost is not a factor in this decision.

**The Art. 33 consequence is accepted.** R2 was chosen over a domestic provider, so the transfer is real and must be disclosed — a paragraph in the privacy policy and an entry in the subprocessor inventory. That work lands in M6 regardless of when backups themselves are built, so it is not deferred with BL-001.

## 16. Environments

**There is no staging environment, and none is planned.**

| | |
|---|---|
| **AR-67** | Production is the only deployed environment. Development is local. |
| **AR-68** | Migrations are rehearsed against a **restored production backup, locally** — which is why AR-65's restore drill carries double duty. Until BL-001 ships there is no such backup, so rehearsal runs against seeded data and carries less assurance. |
| **AR-69** | Because there is no staging safety net, DV-27's expand/contract discipline is not optional. Every schema change must be safe to deploy alongside the previous version of the code, and safe to roll back to. |
| **AR-70** | Revisit when a second developer joins, or the first time a migration causes an incident — whichever comes first. |

### Deployment environment variables

Secrets and connection details live in the environment, never in the SPEC-002 config registry (AR-43). On the VPS they sit in a root-only `.env` injected through Compose; in CI they are Actions secrets.

| Variable | Where it is set | Notes |
|---|---|---|
| `DATABASE_URL` | VPS `.env` | Runtime, as the restricted `allmywallet_app` role (AR-11) |
| `DATABASE_MIGRATION_URL` | Deploy step only | Absent from the running containers by design |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | VPS `.env` | Required wherever auth runs; enforced by `requireAuthEnv()` |
| **`AUTH_URL`** | **`docker-compose.yml`, derived from `DOMAIN`** | **The canonical public origin, `https://<DOMAIN>/api/auth`** |
| `AUTH_TRUST_HOST` | Local and CI only | A production *build* served over localhost — never the deployed app |
| `DOMAIN` | VPS `.env` | One hostname, shared by Caddy's certificate and `AUTH_URL` |
| `SENTRY_DSN`, `LOG_LEVEL`, `IMPORT_UPLOAD_DIR` | VPS `.env` | |

**Auth.js host trust is pinned, not delegated to a header** (#42). Auth.js refuses to build absolute URLs from an untrusted `Host`, and its own default chain ends in `NODE_ENV !== 'production'` — so development trusts the host and production does not. With nothing configured, a deployed instance throws on every session read and renders it as "signed out": it runs, and recognises nobody.

`AUTH_URL` was chosen over `AUTH_TRUST_HOST` because pinning does not depend on the network topology staying as it is. Caddy is the only route in today, but header trust is only safe while that remains true, and nothing would announce it changing. `src/lib/trusted-host.ts` asserts the choice at startup, so a misconfigured deploy fails its health check instead of serving a signed-out shell.

---

## Amendments to existing specs

Two specs are amended by decisions taken here:

| Spec | Rule | Amendment |
|---|---|---|
| SPEC-016 | BR-016-07 | Performance budgets become **advisory, run nightly against `main`** rather than blocking each PR. The seeded reference workload makes per-PR runs too slow. Regressions alert; they do not block. |
| SPEC-003 | BR-003-09 | "Managed secret store" is realised as **root-only `.env` on the VPS injected via Docker Compose**, plus GitHub Actions secrets for CI. Named explicitly rather than left aspirational. |

SPEC-003 BR-003-04 (isolation tests blocking) stands unchanged and remains a merge gate.
