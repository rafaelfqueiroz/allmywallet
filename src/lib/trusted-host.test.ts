import { describe, expect, it } from 'vitest';
import { UntrustedHostConfigurationError, assertTrustedHostConfigured } from '@/lib/trusted-host';

/**
 * SPEC-001 (#42). The rule under test is a *startup* rule, so what matters is
 * which environments boot and which refuse to — asserted directly rather than
 * through `src/auth.ts`, which cannot be imported here (see the header of
 * `session.test.ts`).
 */
const base = { NODE_ENV: 'production' } as const;

describe('assertTrustedHostConfigured (#42)', () => {
  describe('outside production', () => {
    // Auth.js's own default chain ends in `NODE_ENV !== 'production'`, so
    // there is nothing to enforce and requiring configuration would only make
    // `pnpm dev` harder to start.
    it.each(['development', 'test'] as const)('requires nothing under NODE_ENV=%s', (nodeEnv) => {
      expect(() => assertTrustedHostConfigured({ NODE_ENV: nodeEnv })).not.toThrow();
    });

    it('does not demand https of a development AUTH_URL', () => {
      expect(() =>
        assertTrustedHostConfigured({
          NODE_ENV: 'development',
          AUTH_URL: 'http://localhost:3000/api/auth',
        }),
      ).not.toThrow();
    });
  });

  describe('in production', () => {
    // The #42 state itself: nothing configured. This is the one that has to
    // fail, because it is the one that otherwise runs perfectly while
    // recognising nobody.
    it('refuses to boot when neither variable is set', () => {
      expect(() => assertTrustedHostConfigured(base)).toThrow(UntrustedHostConfigurationError);
    });

    it('names both remedies in the failure, since which one applies depends on the process', () => {
      expect(() => assertTrustedHostConfigured(base)).toThrow(/AUTH_URL/);
      expect(() => assertTrustedHostConfigured(base)).toThrow(/AUTH_TRUST_HOST/);
    });

    it('accepts a pinned https origin — the deployed answer', () => {
      expect(() =>
        assertTrustedHostConfigured({
          ...base,
          AUTH_URL: 'https://allmywallet.example.com/api/auth',
        }),
      ).not.toThrow();
    });

    // A production build served over localhost — the Docker builder stage and
    // the E2E and visual CI jobs. No canonical origin exists to pin.
    it('accepts header trust when no origin is pinned', () => {
      expect(() => assertTrustedHostConfigured({ ...base, AUTH_TRUST_HOST: 'true' })).not.toThrow();
    });

    // http would mean the session cookie and every callback URL are built
    // from a clear-text origin, behind a proxy that terminates TLS (AR-56).
    it('rejects a plain-http AUTH_URL', () => {
      expect(() =>
        assertTrustedHostConfigured({
          ...base,
          AUTH_URL: 'http://allmywallet.example.com/api/auth',
        }),
      ).toThrow(/must be https/);
    });

    // A pinned origin wins outright: `reqWithEnvURL` rewrites the request
    // origin before Auth.js sees it, so the header cannot reach a callback
    // URL whatever AUTH_TRUST_HOST says. Asserting it does not throw is the
    // point — an operator who sets both should get a working app, not a boot
    // failure over a redundant variable.
    it('still enforces https when both variables are set', () => {
      expect(() =>
        assertTrustedHostConfigured({
          ...base,
          AUTH_URL: 'http://allmywallet.example.com/api/auth',
          AUTH_TRUST_HOST: 'true',
        }),
      ).toThrow(/must be https/);
    });

    it('accepts both together when the pinned origin is https', () => {
      expect(() =>
        assertTrustedHostConfigured({
          ...base,
          AUTH_URL: 'https://allmywallet.example.com/api/auth',
          AUTH_TRUST_HOST: 'true',
        }),
      ).not.toThrow();
    });
  });
});
