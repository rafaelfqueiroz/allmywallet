import { defineConfig, devices } from '@playwright/test';

/**
 * TESTING §6: E2E covers the journeys where a break makes the product
 * unusable — deliberately few, because they are slow and brittle.
 * TS-26: no E2E test depends on a live external provider; the quote provider is
 * stubbed at the network boundary.
 *
 * Two suites, one config (DL-27, DL-16):
 *
 * - `tests/e2e/` — behaviour. Runs on desktop and on a phone viewport, because
 *   DL-12 makes mobile a first-class target and the navigation is a different
 *   component there.
 * - `tests/visual/` — screenshot baselines of the primitives route, across
 *   light/dark and desktop/mobile. Split out because they are the only tests
 *   whose baselines are platform-dependent (DL-C2) and therefore the only ones
 *   that must run in the pinned container.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },

  /*
   * Baselines are keyed by project name only — never by the host platform.
   * The default template includes the OS, which would quietly let a macOS
   * baseline and a Linux baseline coexist for the same test and never compare;
   * pinning the name is what makes `pnpm test:visual` in the container the
   * single source of truth (DL-C2).
   */
  snapshotPathTemplate: '{testDir}/visual/__screenshots__/{projectName}/{arg}{ext}',

  projects: [
    {
      name: 'e2e-desktop',
      testMatch: /e2e\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e-mobile',
      testMatch: /e2e\/.*\.spec\.ts/,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'visual-desktop-light',
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'visual-desktop-dark',
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
    {
      name: 'visual-mobile-light',
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices['Pixel 5'], colorScheme: 'light' },
    },
    {
      name: 'visual-mobile-dark',
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices['Pixel 5'], colorScheme: 'dark' },
    },
  ],

  // Spread rather than assign `undefined`: `exactOptionalPropertyTypes` (DV-01)
  // distinguishes "absent" from "present and undefined", and Playwright means
  // the former when an external server is already running.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          /*
           * `next start` does not serve a `output: 'standalone'` build — it
           * prints a warning and serves nothing useful, which is how the first
           * attempt at this suite "passed" with zero tests. The standalone
           * server needs the static assets copied next to it, which `next
           * build` deliberately leaves to the deployer.
           */
          command: 'pnpm e2e:server',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
        },
      }),
});
