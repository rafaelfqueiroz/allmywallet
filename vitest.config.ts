import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

/**
 * `src/lib/env.ts` validates at import time and several modules
 * (`src/db/client.ts`, `src/db/tenant.ts`, `src/auth.ts`) construct
 * connection/adapter singletons as a side effect of being imported at all —
 * so the process needs *some* syntactically valid values present before any
 * test file's static imports run, even in suites that never touch a real
 * database (TS-01) and even when the real value (a Testcontainers URL) isn't
 * known until a dynamic `beforeAll`. Integration/isolation tests that do need
 * a real database build their own `Database` instance from the started
 * container's connection string and pass it explicitly (e.g. `withTenant`'s
 * injectable `database` parameter) — these are never it.
 */
const testEnv = {
  NODE_ENV: 'test' as const,
  // Defer to a real URL when the environment supplies one. Overriding it
  // unconditionally poisons `startTestDatabase`'s reuse path: with a CI service
  // container, `DATABASE_URL` is how the suite finds the real database, and
  // replacing it with a placeholder pointed every integration and isolation
  // test at a database that does not exist. The placeholder exists only to get
  // past import-time validation where no database is involved at all.
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://allmywallet_app:allmywallet@localhost:5432/allmywallet_unused_placeholder',
  AUTH_SECRET: 'vitest-placeholder-secret-not-a-real-secret-000',
  AUTH_GOOGLE_ID: 'vitest-placeholder-google-client-id',
  AUTH_GOOGLE_SECRET: 'vitest-placeholder-google-client-secret',
};

/**
 * TESTING §2 — four projects, because they have genuinely different costs and
 * different gates. Unit and use-case tests never touch a database (TS-01);
 * integration and isolation tests run against real Postgres via Testcontainers,
 * because mocking the database would mock away the thing under test.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          // tests/structural: TS-32/BR-016-07a's snapshot-read check — a
          // source-code scan, not a database test, so it belongs in the fast,
          // always-blocking project rather than tests/performance/'s nightly one.
          include: ['src/**/*.test.ts', 'tests/structural/**/*.test.ts'],
          // Component tests are the `components` project below — they need a
          // DOM, and running them here as well would run them twice, once in
          // an environment that cannot render.
          //
          // Selected by **extension** rather than by directory: a `.test.tsx`
          // renders JSX and therefore needs jsdom wherever it happens to sit,
          // and colocating a chart test next to the route that owns it
          // (`src/app/…/_components/`) is the right place for it. Keying the
          // split on `src/components/**` instead meant such a test was
          // collected here, in a `node` environment that cannot render, and
          // failed for a reason that had nothing to do with the component.
          exclude: ['src/components/**'],
          environment: 'node',
          env: testEnv,
        },
      },
      {
        resolve: { alias },
        test: {
          // DL-09 — the design system's a11y and keyboard gate. jsdom, so it is
          // fast enough to stay blocking; see tests/setup/components.ts for what
          // that environment cannot see.
          name: 'components',
          // Every `.test.tsx` in `src/`, plus `.test.ts` under
          // `src/components/**`. The first half is the rule — JSX needs a DOM;
          // the second half exists because `unit` excludes that directory
          // wholesale, so a non-JSX test there (palette tables, prop helpers)
          // would otherwise be collected by no project at all and silently
          // never run.
          include: ['src/**/*.test.tsx', 'src/components/**/*.test.ts'],
          environment: 'jsdom',
          env: testEnv,
          setupFiles: ['tests/setup/components.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          env: testEnv,
          // Containers are slow to start and the suite shares them.
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.test.ts'],
          environment: 'node',
          env: testEnv,
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'performance',
          include: ['tests/performance/**/*.test.ts'],
          environment: 'node',
          env: testEnv,
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.d.ts',
        // TS-30: do not chase coverage on framework wiring by testing framework
        // behaviour. These files construct a pool, register a queue consumer,
        // render a route or configure next-intl — they hold no decision worth
        // asserting, and the behaviour that matters in them is exercised by the
        // integration, isolation and E2E suites against the real thing.
        'src/db/migrations/**',
        'src/db/migrate.ts',
        'src/db/client.ts',
        'src/db/schema/**',
        // SPEC-016: a thin `pnpm db:seed:reference` entrypoint (module-level
        // singleton pool + a process.argv-guarded main, same shape as
        // migrate.ts above). The upsert-by-id logic it wraps is exercised for
        // real by tests/integration/seed-reference.test.ts; the pure
        // generator it calls (src/db/reference-workload.ts) is not excluded
        // and carries its own unit tests.
        'src/db/seed-reference.ts',
        'src/app/**',
        // The render/audit harness the component tests import. Test
        // infrastructure, not a subject.
        'src/components/test-utils.tsx',
        // Test scaffolding, held to the same rule as `test-utils.tsx` above:
        // hand-written fakes and generators exist to exercise product code,
        // and measuring them pulls the 100 %-branch gate on
        // `core/reporting/**` onto a fake port's convenience defaults rather
        // than onto the calculations the gate is there for.
        'src/core/reporting/test-support.ts',
        // SPEC-018 — same reasoning as `core/reporting/test-support.ts`
        // above: hand-written fakes and builders exist to exercise the
        // opportunity module's own decisions, and measuring the fakes
        // themselves would pull the 100 %-branch gate below onto a port
        // stub's convenience defaults instead of onto buy/sell/hold logic.
        'src/core/opportunity/test-support.ts',
        'src/worker/index.ts',
        'src/i18n/request.ts',
        // SPEC-001: Auth.js configuration and provider wiring — the decisions
        // inside it (idempotent provisioning, the `google_subject_id`
        // extraction, session shaping) live in provision-tenant.ts and
        // user-repository.ts instead, which *are* covered. Also genuinely
        // un-importable from Vitest's plain Node environment as of this
        // Next.js 16 / next-auth v5-beta pairing (next-auth's internal
        // `next/server` import doesn't resolve here) — exercised for real by
        // `pnpm build` and the E2E sign-in journey instead.
        'src/auth.ts',
        // TESTING §1: RLS and the transaction-scoped set_config call cannot be
        // proven against a mock — that would mock away the exact thing under
        // test. withTenant is straight-line (no branches) and is proven
        // against real Postgres by tests/isolation/two-tenant-rls.test.ts.

        // TS-30: an adapter/repository — covered by
        // tests/integration/user-repository.test.ts exercising real Postgres,
        // not by chasing unit coverage on Drizzle query-builder calls.
      ],
      thresholds: {
        // TS-28: 80% is the floor everywhere...
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // ...and the calculation engine is held to 100% *branch* coverage,
        // because its edge cases (position closed to zero, missing rate, zero
        // quantity) are branches. Lines alone would pass while missing them.
        'src/core/positions/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/core/valuation/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/core/reporting/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        // SPEC-019 — a goal's progress is a figure a user reads to decide
        // whether a plan is working. Wrong is worse than missing, so it joins
        // the engine's gate rather than the 80 % floor.
        'src/core/goals/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        // SPEC-018 — this module decides whether someone's inbox is written
        // to and what state their screen shows for a rule they set up
        // themselves. Wrong is worse than missing (a silently-skipped email
        // is recoverable; a wrong buy/sell state or a duplicate send is not),
        // so it joins the engine's gate rather than the 80 % floor.
        'src/core/opportunity/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
