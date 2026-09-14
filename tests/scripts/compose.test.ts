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

  function config(args: string[], env: Record<string, string>): ComposeConfig {
    const { DOMAIN: _domain, ...inherited } = process.env;
    const output = execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
      cwd: resolve('.'),
      env: { ...inherited, ...env },
      encoding: 'utf-8',
    });
    return JSON.parse(output) as ComposeConfig;
  }

  it('the personal project publishes every port on 127.0.0.1 only, runs no Caddy, and needs no DOMAIN', () => {
    const personal = config(
      [
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.personal.yml',
        '--env-file',
        envFile,
        '--profile',
        'app',
      ],
      { ALLMYWALLET_ENV_FILE: envFile, POSTGRES_PASSWORD: 'personal-test-password' },
    );

    // No running app container gets the migrator credential (BR-021-09).
    for (const name of ['web', 'worker']) {
      const variables = Object.keys(personal.services[name]?.environment ?? {});
      expect(variables).not.toContain('PERSONAL_DATABASE_MIGRATION_URL');
      expect(variables).not.toContain('DATABASE_MIGRATION_URL');
      expect(variables).not.toContain('POSTGRES_PASSWORD');
    }

    expect(personal.name).toBe('allmywallet-personal');
    expect(Object.keys(personal.services).sort()).toEqual(['postgres', 'web', 'worker']);

    const ports = Object.values(personal.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.host_ip).toBe('127.0.0.1');
    expect(ports.map((port) => port.published)).not.toContain('5432');

    expect(personal.services.web?.environment?.AUTH_URL).toBe('http://localhost:3100/api/auth');
  });

  it('the personal Postgres refuses to start on the development default password', () => {
    const { POSTGRES_PASSWORD: _password, DOMAIN: _domain, ...inherited } = process.env;
    const failed = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        'docker-compose.yml',
        '-f',
        'docker-compose.personal.yml',
        '--env-file',
        envFile,
        '--profile',
        'app',
        'config',
        '-q',
      ],
      {
        cwd: resolve('.'),
        env: { ...inherited, ALLMYWALLET_ENV_FILE: envFile },
        encoding: 'utf-8',
      },
    );

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('POSTGRES_PASSWORD must come from');
  });

  it('the hosted definition still requires DOMAIN and derives an https AUTH_URL from it', () => {
    // env_file: [.env] must exist for `config` to resolve; a throwaway copy
    // of the hosted file beside an empty one keeps the repo untouched.
    const hosted = mkdtempSync(join(dir, 'hosted-'));
    writeFileSync(join(hosted, '.env'), '');
    execFileSync('cp', [resolve('docker-compose.yml'), hosted]);

    const withDomain = execFileSync(
      'docker',
      ['compose', '--profile', 'app', 'config', '--format', 'json'],
      { cwd: hosted, env: { ...process.env, DOMAIN: 'example.com' }, encoding: 'utf-8' },
    );
    const parsed = JSON.parse(withDomain) as ComposeConfig;
    expect(parsed.services.web?.environment?.AUTH_URL).toBe('https://example.com/api/auth');
    expect(Object.keys(parsed.services)).toContain('caddy');

    // #42: an AUTH_URL in the hosted .env/shell never displaces the DOMAIN derivation.
    const withStrayAuthUrl = execFileSync(
      'docker',
      ['compose', '--profile', 'app', 'config', '--format', 'json'],
      {
        cwd: hosted,
        env: {
          ...process.env,
          DOMAIN: 'example.com',
          AUTH_URL: 'https://elsewhere.example/api/auth',
        },
        encoding: 'utf-8',
      },
    );
    expect(
      (JSON.parse(withStrayAuthUrl) as ComposeConfig).services.web?.environment?.AUTH_URL,
    ).toBe('https://example.com/api/auth');

    const { DOMAIN: _domain, ...withoutDomain } = process.env;
    const failed = spawnSync('docker', ['compose', '--profile', 'app', 'config', '-q'], {
      cwd: hosted,
      env: withoutDomain,
      encoding: 'utf-8',
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('DOMAIN is required');
  });
});
