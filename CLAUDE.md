# CLAUDE.md

Loaded at the start of every session. Orientation and the rules that are expensive to get wrong — everything else is a pointer, not a copy.

## What this is

**AllMyWallet** — a web app for Brazilian retail investors to consolidate stocks, FIIs, BDRs, ETFs, Tesouro Direto, CDB, LCI and LCA into one ledger, group holdings into purpose-driven wallets, and report on performance, portfolio value, earnings and composition.

**Current state: pre-implementation.** The PRD, 16 specs and the engineering guidelines are complete. **No application code exists yet** — no `package.json`, no `src/`. The first implementation task is [#4](https://github.com/rafaelfqueiroz/allmywallet/issues/4) (M0 foundations). Commands in [DEVELOPMENT §5](docs/guidelines/DEVELOPMENT.md#5-local-setup) describe the intended setup; they do not run yet.

## Where the artifacts live

Three surfaces, each with one job. **Do not duplicate content between them** — link instead.

| Surface | Holds | Source of truth for |
|---|---|---|
| **[Wiki](https://github.com/rafaelfqueiroz/allmywallet/wiki)** | [PRD](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD), [16 specs](https://github.com/rafaelfqueiroz/allmywallet/wiki/Specs), [Spec-Template](https://github.com/rafaelfqueiroz/allmywallet/wiki/Spec-Template) | *What* to build and why |
| **[Board](https://github.com/users/rafaelfqueiroz/projects/3/views/1)** | 19 issues — #1–#3 deferred infra, #4–#19 one implementation task per spec | *What is being built now* |
| **This repo** | [`docs/guidelines/`](docs/guidelines/README.md) — architecture, development, testing | *How* to build it |

Product documents are **edited in the wiki**, never mirrored here. Guidelines are edited here and reviewed in PRs.

## Working a task

Each board issue #4–#19 follows a fixed five-section shape: **Description · Spec · Implementation plan · Progress log · Decision log**. That structure exists so work can be carried over between sessions or agents.

1. **Read the linked spec page first.** The issue's implementation plan is a first-read plan, not the requirement. The spec's business rules and acceptance criteria are what must actually hold.
2. **Tick the progress log as you go**, in the issue itself. An issue is complete when every item is checked, including the final "all N spec acceptance criteria verified".
3. **Anything that deviates from the implementation plan goes in the Decision log**, with the reason. This is the handover surface — an unexplained deviation costs the next session the whole investigation again.
4. **Cite spec rules in code**: `// SPEC-007 BR-007-03: sales never alter cost basis` (DV-16).
5. Branch `feat/spec-NNN-short-name`, Conventional Commits, PR using the template in [DEVELOPMENT §7](docs/guidelines/DEVELOPMENT.md#7-git) with `Closes #NN`.

## Orchestration and subagent dispatch

**This section is standing authorization to dispatch subagents on this project** — no need to ask first, provided the work meets the bar below.

The default posture on substantial work is **orchestrator**: plan, dispatch, verify, integrate. The goal is the *cheapest model that can do the job correctly*, not the strongest model on everything.

### When to delegate — and when not to

**Delegate** when the work is multi-step (implement → test → review), when independent pieces can genuinely run in parallel, when a search fans out across many files and only the conclusion is needed, or when a review benefits from cold eyes.

**Do it inline** for a single-file edit, a question answerable from files already read, anything under a handful of tool calls, or anything where writing the brief costs more than doing the work. A subagent starts cold and re-derives context — that is the expensive path, and using it for simple tasks *increases* total cost rather than reducing it.

### Model tiering

Six project agents are defined in [`.claude/agents/`](.claude/agents/), each pinning its own model and constraints. Prefer them over a bare `general-purpose` dispatch — the constraints are in the definition, so the brief does not have to re-derive them.

| Work | Agent | Model |
|---|---|---|
| Repetitive mechanical edits; reporting sweeps | [`chore`](.claude/agents/chore.md) | `haiku` |
| "Where is X", naming sweeps, file location | `Explore` *(built-in, override at dispatch)* | `haiku` |
| `core/` use cases, ports, adapters, wiring | [`spec-implementer`](.claude/agents/spec-implementer.md) | `sonnet` |
| Schema, migration, RLS policy, isolation test | [`migration-author`](.claude/agents/migration-author.md) | `sonnet` |
| App Router, components, charts, i18n | [`ui-implementer`](.claude/agents/ui-implementer.md) | `sonnet` |
| **Calculation engine** — `preço médio`, TWR, XIRR, accrual | [`calc-engine`](.claude/agents/calc-engine.md) | `opus` |
| **AC conformity and correctness review** | [`ac-reviewer`](.claude/agents/ac-reviewer.md) | `opus` |
| Implementation strategy for a whole board task | `Plan` *(built-in)* | `opus` |

Two roles get the strongest model, for the same reason. The **calculation engine** is where a *subtly wrong* answer beats an obvious failure to the worst outcome — it ships, it looks plausible, and a user finds it reconciling against their broker, at which point every number the product ever showed them is in doubt. That is also why it carries the 100% branch-coverage gate. **Review** gets it because catching that class of defect requires the same depth as avoiding it.

`ac-reviewer` is read-only by design: it reports findings rather than fixing them, so nothing is silently repaired before the person who needs to see it does.

At the other end, `chore` is walled off from the calculation engine, migrations, RLS, auth and anything holding money — and is instructed to **stop and report** when a task turns out to need judgement rather than guess at it. On this codebase "repetitive" and "mechanical" are not synonyms, and the cheapest model is the one least likely to notice the difference. Its most valuable use is often the *reporting* sweep — find every hardcoded string, every table lacking an isolation test, every `parseFloat` — which is cheap, exhaustive, and hands a precise list to an expensive agent.

### Briefs are self-contained

A subagent inherits **nothing** from this conversation. Every dispatch carries:

- the board issue number and the **spec wiki URL**;
- the exact `BR-` / `AC-` ids in scope — not "implement the wallet spec";
- the file paths to create or touch, per the issue's Modules table;
- the guideline rules that constrain it, cited by id — at minimum AR-01 (`core/` purity), AR-06–AR-10 (money), AR-11 (`withTenant`), AR-14 (RLS in the same migration);
- the test expectations from the issue's Test plan;
- what to report back.

A brief that says "follow the guidelines" produces an agent that has not read them.

### Parallel versus sequential

**Parallel:** independent modules, independent specs within the same milestone, search fan-out, fixture and scaffolding work.

**Sequential:** implementation → tests → review *on the same module*. Reviewing code that is still moving wastes the review.

Two agents must never write the same files. When parallel work touches overlapping paths, dispatch with `isolation: "worktree"` and integrate the results yourself.

### Review is always a separate dispatch

The agent that wrote the code is the worst judge of whether it satisfies the acceptance criteria. The reviewer gets the **spec URL and the AC list**, never the implementer's summary of what it did — otherwise it grades the summary rather than the code. Two distinct review questions, worth separating when a task is large: *does this satisfy the ACs* and *is this correct*.

`/code-review ultra` is user-triggered and billed — offer it, never attempt to launch it.

### What the orchestrator keeps

Git commits and pushes, wiki edits, board and issue updates, the issue's **Decision log**, and all reporting to the user. Subagents propose; they do not publish.

**Verify rather than trust.** A subagent reporting "all tests pass" is a claim, not a result. Run the gate yourself before ticking a progress item or closing an issue. And a subagent's final report is never shown to the user — relay what matters.

## Rules that cause damage if broken

The full set is [70 `AR-`, 30 `DV-`, 34 `TS-` rules](docs/guidelines/README.md). These are the ones where a violation is expensive or impossible to undo.

1. **`core/` imports no framework** (AR-01) — nothing from `next/*`, `drizzle-orm`, `pg`, or `adapters/`. Enforced by ESLint `import/no-restricted-paths`, not by discipline. It is what keeps the calculation engine testable without a database.
2. **Money is never a JS `number`** (AR-06–AR-10) — `decimal.js` over `NUMERIC(20,8)`. A float reaching a money field corrupts data silently and permanently. The hazards are the JSON boundaries: pg-boss payloads and server-action return values.
3. **Every tenant query runs inside `withTenant`** (AR-11). RLS fails closed, so a forgotten filter returns *nothing* rather than everything — but only when the tenant context is set the one correct way, transaction-scoped.
4. **An RLS policy ships in the same migration as its table** (AR-14). A table live for even one deploy without its policy is a table with no isolation.
5. **No credential is ever collected, transmitted or stored** — not a password, not B3, not a broker, not a bank (SPEC-003 BR-003-08). This is why credential-based scraping of investidor.b3.com.br was rejected outright rather than deferred.
6. **CPF is stripped at parse time and never persisted** (SPEC-004 BR-004-02) — not in the ledger, not in `import_rows.raw_payload`, not in logs, not in Sentry. Scheduled in M1 rather than the M6 LGPD milestone precisely because it cannot be retrofitted.
7. **Real B3 extracts never enter the repository** (DV-24, TS-19). They contain a real CPF and real holdings. Test fixtures are generated, never captured. `.gitignore` covers `*.xlsx`, `.env*` and dumps; the discipline covers the rest.

## Constraints that shaped the design

Worth knowing before proposing anything that contradicts them.

- **B3's Área do Investidor APIs are B2B-only** — *"Não oferecemos acesso direto às APIs para pessoas físicas."* So v1 custody data comes from user-exported `.xlsx` extracts; only market data syncs automatically. An `IngestionPort` keeps the Open Finance aggregator path open as a v2 adapter. [PRD §4](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD#4-data-sourcing-strategy).
- **The quote tier is free**: 15,000 requests/month, one ticker per call, ~30 min delay, **no dividend data**. That is a ceiling of roughly 42 distinct assets at a 30-minute cadence. Forward-looking earnings ship degraded and say so.
- **Transactions are the single append-only source of truth.** Positions, valuations and every report figure derive from them and must always be rebuildable. Wallets are views over the ledger; they never duplicate transactions.
- **"Patrimônio" is *Portfolio Value* in English**, never "Net Worth" — net worth is assets minus liabilities, and this product tracks no liabilities.
- **Production only, no staging, none planned** ([BL-003](https://github.com/rafaelfqueiroz/allmywallet/issues/3)). This makes expand/contract migrations mandatory (AR-69), not a preference.
- **Backups are deferred** ([BL-001](https://github.com/rafaelfqueiroz/allmywallet/issues/1), Cloudflare R2 decided). Safe while there is no data; the trigger is **the first real user account**, which is earlier than "before launch".
- **Configurability is a requirement, not a nicety** (SPEC-002). Cadences, thresholds and budgets are config-registry keys, never constants.

## Conventions

| | |
|---|---|
| Package manager | `pnpm`, lockfile committed, CI uses `--frozen-lockfile` |
| Files | `kebab-case.ts`; React components `PascalCase.tsx` |
| Directories | domain concepts — `core/valuation/`, not `core/services/` |
| Imports | `@/` alias from `src/`; never `../../../` |
| Tests | next to their subject — `average-cost.ts` → `average-cost.test.ts` |
| Migrations | forward-only SQL, `snake_case` |
| UI language | pt-BR through `next-intl`; no string literals in components |
| Market vocabulary | stays Portuguese — *proventos*, *preço médio*, *patrimônio*, *rentabilidade* |

## What blocks a merge

Typecheck · lint (incl. import boundaries) · format · unit and use-case tests · integration tests against real Postgres · **isolation tests for every tenant-scoped table** · coverage (100% branch on calculation modules, 80% overall) · migration applies cleanly to an empty database · E2E journeys · reports read snapshots rather than the ledger.

Performance budgets are **nightly and advisory**, not blocking — but the cheap structural check that predicts them *is* blocking. See [the amendments table](docs/guidelines/README.md#amendments-these-guidelines-make-to-the-specs); the guidelines amend two spec rules and both are recorded there so the two surfaces cannot silently disagree.

## Notes for agents

- **Ask before creating a new spec or PRD section.** The PRD is traceability-checked — 181 requirements mapped to 16 specs, with no orphans. Adding requirements without updating [PRD §12](https://github.com/rafaelfqueiroz/allmywallet/wiki/PRD) breaks that.
- **`gh` is authenticated as `rafaelfqueiroz`** with the `project` scope. Board and wiki edits go through it.
- **The wiki is a separate git repository** — `allmywallet.wiki.git`, cloned separately from the code repo.
- **This machine runs bash 3.2.57**, which mis-parses heredocs nested inside `$( )` and `bash -n` does not catch it. Use `--body-file` with a top-level heredoc when writing issue or PR bodies.
