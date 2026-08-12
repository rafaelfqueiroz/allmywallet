import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // AR-58: images are built in CI, never on the VPS. Standalone output is what
  // keeps the 2-vCPU box viable — it only pulls and runs.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // AR-53: spreadsheets are parsed in the worker, not here. `exceljs` has no
  // business being bundled into the request path.
  serverExternalPackages: ['exceljs', 'pg', 'pg-boss', 'pino'],
};

export default withNextIntl(nextConfig);
