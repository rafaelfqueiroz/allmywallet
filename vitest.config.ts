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
  DATABASE_URL:
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
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'node',
          env: testEnv,
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
        'src/app/**',
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
        'src/db/tenant.ts',
        // TS-30: an adapter/repository — covered by
        // tests/integration/user-repository.test.ts exercising real Postgres,
        // not by chasing unit coverage on Drizzle query-builder calls.
        'src/adapters/db/user-repository.ts',
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
      },
    },
  },
});
