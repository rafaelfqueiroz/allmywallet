import type { Env } from '@/lib/env';

/**
 * SPEC-001 (#42) — Auth.js host trust, decided and enforced at startup.
 *
 * **The defect this exists to prevent.** Auth.js refuses to build absolute
 * URLs from an untrusted `Host` header. Its own default chain
 * (`@auth/core/lib/utils/env.js`) ends in `NODE_ENV !== 'production'`, so
 * development trusts the host and *production does not* — and with nothing
 * configured, every session read on a deployed instance throws
 * `UntrustedHost` rather than resolving. `tryUserId()` used to swallow that
 * and render it as "signed out". The app looked like it worked; it simply
 * never recognised anyone. That is the worst shape a defect can take: silent,
 * total, and indistinguishable from a user who has not signed in.
 *
 * **The decision.** Three options satisfy Auth.js and they are not
 * equivalent:
 *
 * | Option | What it means |
 * |---|---|
 * | `AUTH_TRUST_HOST=true` | Trust the incoming `Host`/`X-Forwarded-Host`. Correct only if *nothing* can reach the app except through the reverse proxy — otherwise the header is attacker-controlled and can poison a callback URL. |
 * | `AUTH_URL=https://…` | Pin the canonical origin. The header stops mattering: `reqWithEnvURL` rewrites the request origin before Auth.js sees it. |
 * | `trustHost: true` in `src/auth.ts` | The same trust as the env var, but baked into the image and impossible to vary per environment. |
 *
 * **Production pins with `AUTH_URL`; local and CI use `AUTH_TRUST_HOST`.**
 * The web container publishes no port of its own and Caddy is the only route
 * in *today* — but "today" is not an invariant, and a header-trust decision
 * that depends on the network topology staying exactly as it is now is a
 * decision that expires without telling anyone. The third option was rejected
 * outright: baking trust into the image removes the ability to differ between
 * a localhost E2E run and a public deployment, which is the entire
 * distinction being made here.
 *
 * **What this asserts, and what it deliberately does not.** It fails the boot
 * when a production process has *neither* variable — the exact #42 state, and
 * the only one that is silent. It does not forbid `AUTH_TRUST_HOST` in
 * production, because it cannot tell CI's production build served over
 * localhost from a deployed one, and a rule that cannot distinguish those two
 * either breaks the E2E suite or means nothing. Keeping header trust out of
 * production is enforced where it can be: `docker-compose.yml` sets `AUTH_URL`
 * on the `web` service from `DOMAIN`, so the deployed app is pinned whatever
 * the VPS `.env` happens to contain.
 *
 * **Why a startup assertion rather than a comment.** The failure mode is
 * silent by construction, so the only useful place to catch it is before the
 * server accepts its first request (AR-40/AR-41, the same reasoning as
 * `requireAuthEnv()`). A deploy that can authenticate nobody should fail its
 * health check, not serve a signed-out shell to every visitor.
 *
 * Lives in its own module rather than inside `src/auth.ts` because that file
 * statically imports `next-auth`, which is un-importable from a Vitest unit
 * test under this project's Next 16 / next-auth v5-beta pairing (see the
 * header of `src/lib/session.test.ts`). The rule is worth testing; that import
 * constraint should not be what decides whether it can be.
 */
export class UntrustedHostConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedHostConfigurationError';
  }
}

type HostEnv = Pick<Env, 'NODE_ENV' | 'AUTH_URL' | 'AUTH_TRUST_HOST'>;

export function assertTrustedHostConfigured(e: HostEnv): void {
  // Outside production Auth.js trusts the host on its own, so requiring
  // anything here would only make `pnpm dev` harder to start for no security
  // gain.
  if (e.NODE_ENV !== 'production') return;

  if (!e.AUTH_URL) {
    // `AUTH_TRUST_HOST` is the sanctioned answer for a production *build*
    // served over localhost — the Docker builder stage, and the E2E and
    // visual CI jobs, which run the standalone output.
    if (e.AUTH_TRUST_HOST) return;

    throw new UntrustedHostConfigurationError(
      'Neither AUTH_URL nor AUTH_TRUST_HOST is set in production (#42). Auth.js then treats ' +
        'every host as untrusted and every session read throws, which surfaces as "signed out" ' +
        'on every screen rather than as an error — the app runs and recognises nobody. ' +
        'Deployed: set AUTH_URL to the canonical public origin including the base path, e.g. ' +
        'AUTH_URL=https://allmywallet.example.com/api/auth (docker-compose.yml derives it from ' +
        'DOMAIN, the same value Caddy requests its certificate for). A production build served ' +
        'over localhost: set AUTH_TRUST_HOST=true instead.',
    );
  }

  // A production `AUTH_URL` on plain http means callback URLs and the session
  // cookie are built from a clear-text origin. Caddy terminates TLS in front
  // of the app (AR-56), so this can only be a typo — but it is a typo that
  // downgrades the whole sign-in flow, and nothing else would notice it.
  if (!e.AUTH_URL.startsWith('https://')) {
    throw new UntrustedHostConfigurationError(
      `AUTH_URL must be https in production (#42); got "${e.AUTH_URL}". Callback URLs and the ` +
        'session cookie are built from this origin, and Caddy terminates TLS in front of the ' +
        'app (AR-56). For a production build served over localhost, leave AUTH_URL unset and ' +
        'set AUTH_TRUST_HOST=true.',
    );
  }
}
