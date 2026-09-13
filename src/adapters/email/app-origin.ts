import { env } from '@/lib/env';

/**
 * `AUTH_URL` (SPEC-001 #42) is `https://host/api/auth` — or, on the personal
 * instance, `http://localhost:3100/api/auth` (SPEC-021 BR-021-11). `URL.origin`
 * strips the path, which is exactly the canonical origin a link in an email
 * needs. Falls back to a local default outside production, where `AUTH_URL`
 * is legitimately unset (`src/lib/trusted-host.ts`).
 */
export function appOrigin(): string {
  const authUrl = env().AUTH_URL;
  if (authUrl !== undefined) {
    try {
      return new URL(authUrl).origin;
    } catch {
      // Falls through to the local default below — an unparsable AUTH_URL is
      // already a startup-time failure elsewhere (`assertTrustedHostConfigured`);
      // this function only ever renders a link, it does not gate a deploy.
    }
  }
  return 'http://localhost:3000';
}
