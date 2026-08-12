import { defineConfig, devices } from '@playwright/test';

/**
 * TESTING §6: E2E covers the journeys where a break makes the product
 * unusable — deliberately few, because they are slow and brittle.
 * TS-26: no E2E test depends on a live external provider; the quote provider is
 * stubbed at the network boundary.
 */
export default defineConfig({
  testDir: './tests/e2e',
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Spread rather than assign `undefined`: `exactOptionalPropertyTypes` (DV-01)
  // distinguishes "absent" from "present and undefined", and Playwright means
  // the former when an external server is already running.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm build && pnpm start',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
      }),
});
