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
  /*
   * SPEC-005 AC-1's export screenshots are the only images this product
   * serves, and they ship already cropped and sized for where they render.
   * The optimiser would add nothing and would add `sharp` — a native
   * dependency in the runtime image (AR-58) — to resize three static PNGs
   * that are 40 KB each. `next/image` still gives the intrinsic dimensions,
   * so the layout does not shift while they load.
   */
  images: { unoptimized: true },
};

export default withNextIntl(nextConfig);
