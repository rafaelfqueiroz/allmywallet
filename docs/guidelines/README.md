# Engineering Guidelines

How the [specs](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs) get built. Four documents, each answering a different question.

These guidelines live in the repository, next to the code they govern. The **[PRD](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD)** and **[specifications](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs)** live in the wiki; work is tracked on the **[project board](https://github.com/users/rafaelfqueiroz/projects/3/views/1)**.

| Doc | Answers |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How the system is shaped — layering, runtime topology, RLS, money, jobs, database, errors, observability |
| **[DEVELOPMENT.md](DEVELOPMENT.md)** | How to work — dependencies, conventions, git, CI/CD, deployment, ADRs, definition of done |
| **[TESTING.md](TESTING.md)** | How correctness is proven — strategy, test types, coverage gates, fixtures, what blocks a merge |
| **[DESIGN.md](DESIGN.md)** | How the interface is built — tokens, theming, colour, density, primitive contracts |

Rules are numbered `AR-nn` (architecture) and `DV-nn` (development), `TS-nn` (testing), `DS-nn` (design), so they can be cited from code comments and PRs the same way spec rules are.

## The stack, in one table

| | |
|---|---|
| Language / framework | TypeScript (strict) · Next.js App Router |
| Database | PostgreSQL 17+ · Drizzle · forward-only SQL migrations |
| Isolation | Row-Level Security, transaction-scoped tenant context |
| Money | `decimal.js` over `NUMERIC(20,8)` — never floating point |
| Auth | Auth.js v5, Google only |
| Jobs | pg-boss, in a separate worker process |
| UI | Tailwind · shadcn/ui · Recharts · TanStack Table · next-intl (pt-BR) |
| Testing | Vitest · Testcontainers · Playwright |
| Hosting | Single São Paulo VPS · Docker Compose · Caddy |
| CI/CD | GitHub Actions → GHCR image → SSH deploy |

## Five rules that carry the most weight

Everything else is convention. These five are the ones where a violation causes damage that is expensive or impossible to undo:

1. **`core/` imports no framework** (AR-01). It is what keeps the calculation engine testable without a database, and it is enforced by lint rather than by discipline.
2. **Money is never a JS `number`** (AR-06–AR-10). A float reaching a money field corrupts data silently and permanently. Watch job payloads and server-action returns — both are JSON.
3. **Every tenant query runs inside `withTenant`** (AR-11). RLS fails closed, so a forgotten filter returns nothing instead of everything — but only if the tenant context is set the one correct way.
4. **The RLS policy ships in the same migration as its table** (AR-14). A table that exists for even one deploy without its policy is a table with no isolation.
5. **Real B3 extracts never enter the repository** (DV-24, TS-19). They contain a real CPF and real holdings — precisely what SPEC-004 exists to keep out of the system. Test fixtures are generated, never captured.

## What blocks a merge

| Check | Blocking |
|---|---|
| Typecheck · lint (incl. import boundaries) · format | ✅ |
| Unit + use-case tests | ✅ |
| Integration tests against real Postgres | ✅ |
| **Isolation tests — every tenant-scoped table** | ✅ |
| Coverage — 100% branch on calculation modules, 80% overall | ✅ |
| Migration applies cleanly to an empty database | ✅ |
| E2E journeys (desktop + mobile) | ✅ |
| Visual baselines, light/dark × desktop/mobile | ✅ |
| Reports read snapshots, not the ledger | ✅ |
| Performance budgets | ⚠️ Nightly, advisory |

## Amendments these guidelines make to the specs

Recorded here so the specs and the guidelines cannot silently disagree:

| Spec | Rule | Change |
|---|---|---|
| SPEC-016 | BR-016-07 | Performance budgets moved from per-PR blocking to **nightly advisory**; new BR-016-07a keeps the cheap structural check blocking |
| SPEC-003 | BR-003-09 | "Managed secret store" made concrete: **root-only `.env` on the VPS** + GitHub Actions secrets |
| SPEC-012 | AC-14, AC-16 | **Wallet scope is current composition, not history.** TWR, XIRR, "% do CDI", real return and the shadow portfolio are *unavailable* at wallet scope and say so; the contribution table and the pure index lines are correct there. Decided in [#50](https://github.com/rafaelfqueiroz/allmywallet/issues/50) |
| SPEC-013 | BR-013-05 | Same cause: the stacked series answers `asset_class` only, and names the dimension it cannot decompose along |

SPEC-003 BR-003-04 — isolation tests blocking — stands unchanged.

### Why wallet scope has no history

SPEC-010 BR-010-08 makes wallets **views over a single ledger** — a transaction is never duplicated to belong to one. SPEC-012 and SPEC-013 then ask for per-wallet *returns over time* and *historical composition*, which is a materially stronger claim: it requires the allocation itself to have a history, so a chart can say what the split was on each past day rather than projecting today's split backwards.

Storing that means rows multiplying by the cardinality of every dimension over every day of history, populated by both `valuation.snapshot` and BR-009-18's forward-invalidation rebuild, as an expand/contract migration against a production database with no staging to rehearse against. That is a permanent carrying cost on the rebuild path — the one path that must stay correct, because DL-006-01 makes the ledger authoritative and the rebuild is how that authority is exercised.

So the refusals are the answer, not a gap: each names the missing dimension rather than borrowing the portfolio's series or rendering empty bands. **Reopen #50 if the PRD ever commits to per-wallet performance as a headline capability.**

## Infrastructure

| | |
|---|---|
| **Host** | Hostinger **KVM 2** — 2 vCPU, 8 GB RAM, 100 GB NVMe, **São Paulo** |
| **Backups** | ⏳ **Deferred — [BL-001](https://github.com/rafaelfqueiroz/allmywallet/issues/1).** Cloudflare R2 decided; trigger is the first real user account |
| **Environments** | Production only. **No staging, and none planned** — [BL-003](https://github.com/rafaelfqueiroz/allmywallet/issues/3) |
| **Observability** | Sentry + Pino + Uptime Kuma from M0; metrics stack deferred to M4 — [BL-002](https://github.com/rafaelfqueiroz/allmywallet/issues/2) |

Sizing rationale in [ARCHITECTURE §14](ARCHITECTURE.md#14-host-sizing), backup requirements in [§15](ARCHITECTURE.md#15-backup-and-restore), environments in [§16](ARCHITECTURE.md#16-environments).

Three consequences worth carrying in your head:

- **8 GB is adequate, not generous.** Every Compose service needs an explicit `mem_limit` (AR-57) — Prometheus growing unbounded and OOM-killing Postgres is the classic single-box failure. Upgrade at sustained >6 GB rather than provisioning ahead: KVM 4 renews at roughly double.
- **No staging means expand/contract is mandatory** (AR-69), not a nice-to-have. Every schema change must be safe alongside the previous code version and safe to roll back. The quarterly restore drill doubles as the only migration rehearsal available (AR-65).
- **Backups are deferred, and the trigger is earlier than it sounds** ([BL-001](https://github.com/rafaelfqueiroz/allmywallet/issues/1)). Safe today because there is no data. Unsafe the moment one real user imports one real extract — their broker keeps the trades, but not the wallet structure, manual entries, reconciliation adjustments or corrections. That data exists only here. **Build it before the first non-test account, not before launch.**

## Deferred work

Decided but not built, each with a trigger that ends the deferral — tracked on the [board](https://github.com/users/rafaelfqueiroz/projects/3/views/1).

| ID | Item | Trigger |
|---|---|---|
| BL-001 | Backups to Cloudflare R2 | Before the first real user account |
| BL-002 | Metrics stack — self-host vs Grafana Cloud | M4 |
| BL-003 | Staging environment | Second developer, or a migration incident |

**One consequence that is not deferred:** choosing R2 over a Brazilian provider makes the backup an LGPD Art. 33 international transfer. It must be disclosed in the privacy policy and subprocessor inventory (AR-66, SPEC-004 BR-004-18) — that work belongs to M6 whether or not backups exist by then.
