import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

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
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
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
