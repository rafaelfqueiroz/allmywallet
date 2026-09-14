import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SPEC-021 BR-021-10/11/12 — the Compose definitions as Compose itself
 * resolves them, not as the YAML reads. Compose merges port lists across
 * files unless told otherwise, so "the override says 127.0.0.1" proves
 * nothing; `docker compose config` does.
 *
 * The personal project is resolved through `personal_compose` in
 * scripts/personal/lib.sh — the exact invocation the scripts use — so a test
 * that passes here cannot pass on flags the scripts never send.
 */
const hasDocker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8' }).status === 0;

interface ComposePort {
  readonly host_ip?: string;
  readonly published?: string;
}
interface ComposeConfig {
  readonly name: string;
  readonly services: Record<
    string,
    { ports?: ComposePort[]; environment?: Record<string, string | null> }
  >;
}

describe.skipIf(!hasDocker)('docker compose definitions (SPEC-021)', () => {
  let dir: string;
  let envFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'amw-compose-'));
    envFile = join(dir, 'personal.env');
    writeFileSync(envFile, 'PERSONAL_AUTH_URL=http://localhost:3100/api/auth\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function personalCompose(args: string, env: Record<string, string>) {
    const { DOMAIN: _domain, POSTGRES_PASSWORD: _password, ...inherited } = process.env;
    return spawnSync(
      'bash',
      ['-c', `. "${resolve('scripts/personal/lib.sh')}"; personal_compose ${args}`],
      {
        cwd: resolve('.'),
        env: { ...inherited, ALLMYWALLET_ENV_FILE: envFile, ...env },
        encoding: 'utf-8',
      },
    );
  }

  it('the personal project publishes every port on 127.0.0.1 only, runs no Caddy, and needs no DOMAIN', () => {
    const result = personalCompose('config --format json', {
      POSTGRES_PASSWORD: 'personal-test-password',
    });
    expect(result.status, result.stderr).toBe(0);
    const personal = JSON.parse(result.stdout) as ComposeConfig;

    expect(personal.name).toBe('allmywallet-personal');
    expect(Object.keys(personal.services).sort()).toEqual(['postgres', 'web', 'worker']);

    const ports = Object.values(personal.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.host_ip).toBe('127.0.0.1');
    expect(ports.map((port) => port.published)).not.toContain('5432');

    expect(personal.services.web?.environment?.AUTH_URL).toBe('http://localhost:3100/api/auth');

    // No running app container gets the migrator credential (BR-021-09).
    for (const name of ['web', 'worker']) {
      const variables = Object.keys(personal.services[name]?.environment ?? {});
      expect(variables).not.toContain('PERSONAL_DATABASE_MIGRATION_URL');
      expect(variables).not.toContain('DATABASE_MIGRATION_URL');
      expect(variables).not.toContain('POSTGRES_PASSWORD');
    }
  });

  it('the personal Postgres refuses to start on the development default password', () => {
    const result = personalCompose('config -q', {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('POSTGRES_PASSWORD must come from');
  });

  it('the hosted definition still requires DOMAIN and derives an https AUTH_URL from it', () => {
    // env_file: [.env] must exist for `config` to resolve; a throwaway copy
    // of the hosted file beside an empty one keeps the repo untouched.
    const hosted = mkdtempSync(join(dir, 'hosted-'));
    writeFileSync(join(hosted, '.env'), '');
    execFileSync('cp', [resolve('docker-compose.yml'), hosted]);

    const { DOMAIN: _domain, ...withoutDomain } = process.env;
    const withDomain = execFileSync(
      'docker',
      ['compose', '--profile', 'app', 'config', '--format', 'json'],
      { cwd: hosted, env: { ...withoutDomain, DOMAIN: 'example.com' }, encoding: 'utf-8' },
    );
    const parsed = JSON.parse(withDomain) as ComposeConfig;
    expect(parsed.services.web?.environment?.AUTH_URL).toBe('https://example.com/api/auth');
    expect(Object.keys(parsed.services)).toContain('caddy');

    const failed = spawnSync('docker', ['compose', '--profile', 'app', 'config', '-q'], {
      cwd: hosted,
      env: withoutDomain,
      encoding: 'utf-8',
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('DOMAIN is required');
  });
});
