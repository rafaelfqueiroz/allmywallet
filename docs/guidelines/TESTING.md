# Testing Guidelines

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Companion docs** | [ARCHITECTURE.md](ARCHITECTURE.md), [DEVELOPMENT.md](DEVELOPMENT.md) |

## 1. Philosophy

Effort goes where a bug does real damage. For this product that is not the UI — it is the arithmetic and the tenant boundary.

**A wrong number is worse than a crash.** A crash gets reported. An average cost that is subtly wrong gets trusted, acted on, and filed with Receita Federal. The calculation engine (SPEC-007, SPEC-009, SPEC-012) is therefore tested hardest, against **hand-computed expected values** rather than against the implementation's own output.

**Three things cannot be tested against a mock**, and are therefore tested against real Postgres via Testcontainers:

1. RLS policies — mocking the database mocks away the thing being verified
2. `NUMERIC` ⇄ `Decimal` round-tripping — where floating-point corruption would enter
3. Migration correctness

**Time is an input, not an ambient fact.** SPEC-008's core behaviour is "make no request outside market hours". That is untestable without controlling the clock, which is why `Clock` and `TradingCalendar` are ports (AR-03).

## 2. Test types

| Type | Runs against | Location | Speed |
|---|---|---|---|
| **Domain unit** | Nothing — pure functions | next to source | ms |
| **Use case** | Fake adapters implementing real ports | next to source | ms |
| **Repository / RLS** | Real Postgres (Testcontainers) | `tests/integration/` | seconds |
| **Isolation** | Real Postgres, two tenants | `tests/isolation/` | seconds |
| **E2E** | Full stack, Playwright | `tests/e2e/` | minutes |
| **Performance** | Seeded reference workload | `tests/performance/` | minutes, nightly |

Tooling: **Vitest** everywhere except E2E, which is **Playwright**.

| | |
|---|---|
| **TS-01** | Domain and use-case tests never touch a database. If a test needs one to exercise a domain rule, the layering is wrong (AR-01). |
| **TS-02** | Fakes implement the real port interface. No mocking libraries for ports — a hand-written fake stays honest when the interface changes; a mock silently does not. |
| **TS-03** | Every test is independent and order-agnostic. Integration tests get a fresh schema or a transaction rolled back at teardown. |
| **TS-04** | No test asserts on the implementation's own output as its expectation. Expected values are computed by hand or taken from an external authority. |

## 3. Testing the calculation engine

The highest-value tests in the project.

| | |
|---|---|
| **TS-05** | Every rule in SPEC-007 §Average cost has a test with a **hand-computed** expected value, written into the test as a comment showing the arithmetic. |
| **TS-06** | Corporate events are tested in combination, not just individually: buy → split → buy → bonificação → partial sell, with the average verified at each step. Individually correct handlers that break in sequence is the realistic failure. |
| **TS-07** | Ordering is explicitly tested — a backdated corporate event inserted between existing trades must reorder and produce the same result as if it had always been there (SPEC-007 BR-007-15). |
| **TS-08** | **Rebuild equals incremental** is asserted as a property: for a generated transaction history, rebuilding positions from the ledger must equal the incrementally-maintained state, byte for byte (DM-4). This single test catches most ordering and accumulation bugs. |
| **TS-09** | TWR is tested on its defining property: **adding an uninvested mid-period deposit must not change it**, while XIRR must. If a test suite proves only one number, it has not tested the distinction the report exists to make (SPEC-012 DL-012-01). |
| **TS-10** | Fixed-income accrual is verified against externally computed values — a 110%-of-CDI CDB over a known period, computed independently from published BCB series. |
| **TS-11** | Precision is tested adversarially: hundreds of transactions with repeating decimals, asserting no drift. This is the test that catches a `number` leaking into a money path. |
| **TS-12** | Cross-report invariants are tested end to end: Composition total = Portfolio Value endpoint; Earnings total = Portfolio Value's earnings driver; totals invariant across all groupings. |

## 4. Isolation tests — the blocking gate

Cross-tenant leakage is PRD risk R6: low likelihood, severe impact, and **invisible in single-user development** — a query missing its tenant filter returns your own rows and looks correct.

| | |
|---|---|
| **TS-13** | Every tenant-scoped table has an isolation test. Enforced by a test that **enumerates tables from the database** and fails on any lacking coverage — never a maintained list, which goes stale silently. |
| **TS-14** | Tests run at the **API and report surface**, not the repository layer. Leaks happen in aggregates, exports and caches — above where repository tests look (SPEC-003 DL-003-03). |
| **TS-15** | Standard shape: seed tenants A and B with distinguishable data; as A, exercise every read path; assert nothing of B's appears. |
| **TS-16** | Explicitly test that a query **outside** `withTenant` fails rather than returning everything. |
| **TS-17** | Test that a request supplying another tenant's `user_id` returns the caller's own data and emits a security event (SPEC-003 BR-003-05). |
| **TS-18** | Assert the application role cannot bypass RLS, by inspecting the role's attributes directly. |

**This gate blocks merges.** It is the one CI check that stays blocking regardless of suite time, because the cost of the alternative is a stranger reading someone's complete financial position.

## 5. Fixtures and seeds

| | |
|---|---|
| **TS-19** | **Never commit a real B3 extract.** They contain a real CPF and real holdings — exactly the data SPEC-004 exists to keep out of the system. This applies to test fixtures, bug reports and scratch files. |
| **TS-20** | Synthetic B3 extracts are **generated** by a builder producing structurally faithful `.xlsx` files: real column names and layout, invented data. |
| **TS-21** | Generated extracts cover the awkward cases deliberately: leading metadata rows, reordered columns, unknown movement types, two genuine identical same-day trades, and a CPF field — so CPF stripping is testable. |
| **TS-22** | Domain fixtures use builders with sensible defaults (`aTransaction().buy().of('PETR4').quantity(100)`), so a test states only what it cares about. |
| **TS-23** | The SPEC-016 reference workload — 100 assets, 10,000 transactions, 5 years — is generated deterministically from a fixed seed, so performance numbers are comparable across runs. |
| **TS-24** | `pnpm db:seed` produces a realistic demo tenant for manual testing. It is never run against production. |

## 6. E2E scope

Playwright covers the journeys where a break means the product is unusable — deliberately few, because they are slow and brittle.

1. Sign in with Google (mocked provider) → empty dashboard
2. Upload the three extracts → preview → commit → positions appear
3. Re-import an overlapping range → no duplicates, positions unchanged
4. Create a wallet, assign an asset in one click, verify full-position allocation
5. Open each of the four reports, switch scope and grouping, verify totals do not change
6. Export data and delete the account (SPEC-004 rights)

| | |
|---|---|
| **TS-25** | E2E asserts user-visible outcomes, not internal state. Anything needing internal state is an integration test. |
| **TS-26** | No E2E test depends on a live external provider. The quote provider is stubbed at the network boundary. |
| **TS-27** | Accessibility assertions (axe) run within the E2E suite on core flows, covering SPEC-016 BR-016-15. |

## 7. Coverage gates

| Scope | Threshold | Blocking |
|---|---|---|
| `core/positions/`, `core/valuation/`, `core/reporting/` — the calculation engine | **100% branch** | ✅ |
| Everything else | **80%** | ✅ |
| Isolation coverage — every tenant table | **100%** | ✅ |
| Performance budgets | SPEC-016 | ⚠️ Nightly, advisory |

| | |
|---|---|
| **TS-28** | 100% on calculation modules is branch coverage, not line — the edge cases (position closed to zero, missing rate, zero quantity) are branches, and lines alone would pass while missing them. |
| **TS-29** | Coverage is a floor, not a goal. A covered line proves execution, not correctness — TS-04's hand-computed expectations are what prove correctness. |
| **TS-30** | Do not chase coverage on adapters by testing framework behaviour. Adapters are covered by integration tests exercising real behaviour. |

## 8. Performance testing

Amended from SPEC-016 BR-016-07: **nightly and advisory**, not per-PR blocking. Seeding the reference workload makes it too slow for every push.

| Budget | Target |
|---|---|
| Dashboard load | < 2s p95 |
| Any report, any scope × grouping | < 3s p95 |
| Import preview, 10k rows | < 30s |
| Import commit, 10k rows | < 60s |

| | |
|---|---|
| **TS-31** | Runs nightly against `main` on the seeded reference workload. Regression raises an alert naming the commit range. |
| **TS-32** | A test asserts reports read from `DailyValuationSnapshot` and do not trigger full ledger recomputation (SPEC-016 BR-016-05) — this one **is** cheap and stays in the PR suite, because it catches the architectural regression that causes slowness rather than measuring the symptom. |

TS-32 is the useful compromise: the expensive measurement moves to nightly, but the cheap structural check that predicts it stays blocking.

## 9. What is not tested

Stated so effort is not spent by accident:

- Third-party library internals — Drizzle, Auth.js, Recharts are trusted
- Next.js framework behaviour
- Visual regression / pixel snapshots
- Load and stress beyond the reference workload
- Live provider integration — contract-tested against recorded responses instead
- Backup restore, which is a **quarterly operational drill**, not an automated test (SPEC-016 BR-016-09)

---

## Summary — what blocks a merge

| Check | Blocking |
|---|---|
| Typecheck, lint (incl. import boundaries), format | ✅ |
| Unit + use case tests | ✅ |
| Integration tests, real Postgres | ✅ |
| **Isolation tests, every tenant table** | ✅ |
| Coverage: 100% calc / 80% overall | ✅ |
| Migration applies cleanly to an empty database | ✅ |
| E2E journeys | ✅ |
| Snapshot-read architectural check (TS-32) | ✅ |
| Performance budgets | ⚠️ Nightly |
