import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * SPEC-021 — the personal scripts, driven with stubbed `docker`, `curl`, `age`
 * and `fdesetup` (scripts/personal/lib.sh reaches every external command
 * through a variable for exactly this). What is asserted is what each script
 * *did*: which commands ran, in which order, with which image tag — the only
 * way to prove "a failed backup never reaches the migration" without failing a
 * real backup against real data.
 */
const SCRIPTS = resolve('scripts/personal');

let sandbox: string;
let calls: string;

function stub(name: string, body: string): string {
  const path = join(sandbox, 'bin', name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function loggedCalls(): string[] {
  try {
    return readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function run(script: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync('bash', [join(SCRIPTS, script), ...args], {
    env: {
      NODE_ENV: 'test',
      PATH: `${join(sandbox, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: sandbox,
      ...env,
    },
    encoding: 'utf-8',
  });
}

function lib(snippet: string): string {
  return execFileSync('bash', ['-c', `. ${join(SCRIPTS, 'lib.sh')}; ${snippet}`], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: sandbox },
    encoding: 'utf-8',
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'amw-personal-'));
  mkdirSync(join(sandbox, 'bin'));
  calls = join(sandbox, 'calls.log');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('lib.sh', () => {
  it('prune_backups keeps exactly the newest N dumps and their sidecars', () => {
    const dir = join(sandbox, 'backups');
    mkdirSync(dir);
    for (const day of ['01', '02', '03', '04', '05']) {
      writeFileSync(join(dir, `allmywallet-202609${day}T100000Z.dump.age`), 'x');
      writeFileSync(join(dir, `allmywallet-202609${day}T100000Z.counts.age`), 'x');
    }
    writeFileSync(join(dir, 'unrelated.txt'), 'kept');

    lib(`prune_backups "${dir}" 2`);

    expect(readdirSync(dir).sort()).toEqual([
      'allmywallet-20260904T100000Z.counts.age',
      'allmywallet-20260904T100000Z.dump.age',
      'allmywallet-20260905T100000Z.counts.age',
      'allmywallet-20260905T100000Z.dump.age',
      'unrelated.txt',
    ]);
  });

  it('prune_backups refuses a retain count that is not a positive integer', () => {
    expect(() => lib(`prune_backups "${sandbox}" 0`)).toThrow();
    expect(() => lib(`prune_backups "${sandbox}" abc`)).toThrow();
  });

  it('same_volume is true for two paths on one filesystem', () => {
    mkdirSync(join(sandbox, 'a'));
    mkdirSync(join(sandbox, 'b'));
    expect(() => lib(`same_volume "${sandbox}/a" "${sandbox}/b"`)).not.toThrow();
  });

  it('inside_repo recognises the working tree', () => {
    expect(() => lib(`inside_repo "${resolve('package.json')}"`)).not.toThrow();
    expect(() => lib(`inside_repo "${sandbox}"`)).toThrow();
  });
});

describe('backup.sh', () => {
  function envFile(extra: string): string {
    const path = join(sandbox, 'personal.env');
    writeFileSync(
      path,
      [
        'POSTGRES_USER=allmywallet_migrator',
        'POSTGRES_DB=allmywallet',
        'BACKUP_AGE_RECIPIENT=age1stub',
        extra,
      ].join('\n'),
    );
    return path;
  }

  it('refuses a destination on the same volume as the Postgres data, and prunes nothing (BR-021-18)', () => {
    const backups = join(sandbox, 'backups');
    const pgdata = join(sandbox, 'pgdata');
    mkdirSync(backups);
    mkdirSync(pgdata);
    writeFileSync(join(backups, 'allmywallet-20260901T100000Z.dump.age'), 'old');
    const docker = stub('docker', `echo "docker $*" >> "${calls}"`);

    const result = run('backup.sh', {
      ALLMYWALLET_ENV_FILE: envFile(`BACKUP_DIR=${backups}\nPGDATA_HOST_PATH=${pgdata}`),
      DOCKER: docker,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('same volume');
    // The failure is recorded (BR-021-20), and no dump was attempted.
    expect(loggedCalls().some((call) => call.includes('backup-record failed'))).toBe(true);
    expect(loggedCalls().some((call) => call.includes('exec'))).toBe(false);
    expect(readdirSync(backups)).toEqual(['allmywallet-20260901T100000Z.dump.age']);
  });

  it('never prunes after a failed dump (BR-021-19)', () => {
    const backups = join(sandbox, 'backups');
    mkdirSync(backups);
    for (const day of ['01', '02', '03']) {
      writeFileSync(join(backups, `allmywallet-202609${day}T100000Z.dump.age`), 'x');
    }
    // A different "volume" for the test: /dev is its own filesystem on both macOS and Linux.
    const docker = stub(
      'docker',
      `echo "docker $*" >> "${calls}"
case "$*" in
  *"exec -T postgres"*) cat >/dev/null; echo "pg_dump: error" >&2; exit 3 ;;
  *backup-retain-count*) echo 1 ;;
esac`,
    );
    const age = stub('age', 'cat > /dev/null; exit 0');

    const result = run('backup.sh', {
      ALLMYWALLET_ENV_FILE: envFile(`BACKUP_DIR=${backups}\nPGDATA_HOST_PATH=/dev`),
      DOCKER: docker,
      AGE: age,
    });

    expect(result.status).toBe(1);
    expect(loggedCalls().some((call) => call.includes('backup-record failed'))).toBe(true);
    expect(loggedCalls().some((call) => call.includes('backup-retain-count'))).toBe(false);
    expect(readdirSync(backups).filter((name) => name.endsWith('.dump.age'))).toHaveLength(3);
  });
});

describe('start.sh (BR-021-23–27)', () => {
  interface Scenario {
    offline?: boolean;
    backupExit?: number;
    migrateExit?: number;
    healthExit?: number;
  }

  function startWith(scenario: Scenario) {
    const state = join(sandbox, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'current-tag'), 'local-current\n');
    writeFileSync(join(state, 'last-good-tag'), 'local-lastgood\n');
    writeFileSync(join(state, 'current-digest'), 'sha256:old\n');
    const env = join(sandbox, 'personal.env');
    writeFileSync(
      env,
      'PERSONAL_DATABASE_MIGRATION_URL=postgresql://m@postgres/x\nBACKUP_DIR=/nonexistent\n',
    );

    const docker = stub(
      'docker',
      `echo "IMAGE_TAG=\${IMAGE_TAG:-} docker $*" >> "${calls}"
case "$*" in
  *"imagetools inspect"*) ${scenario.offline ? 'exit 1' : 'echo "Name: x"; echo "Digest: sha256:new"'} ;;
  *"image inspect"*) echo "sha256:0123456789abcdef" ;;
  *"dist/migrate.js"*) exit ${scenario.migrateExit ?? 0} ;;
esac
exit 0`,
    );
    const curl = stub('curl', `echo "curl $*" >> "${calls}"; exit ${scenario.healthExit ?? 0}`);
    const backup = stub(
      'fake-backup',
      `echo "backup" >> "${calls}"; exit ${scenario.backupExit ?? 0}`,
    );

    const result = run('start.sh', {
      ALLMYWALLET_ENV_FILE: env,
      ALLMYWALLET_STATE_DIR: state,
      DOCKER: docker,
      CURL: curl,
      BACKUP_SCRIPT: backup,
      HEALTH_ATTEMPTS: '2',
      HEALTH_INTERVAL: '0',
    });
    const currentTag = readFileSync(join(state, 'current-tag'), 'utf-8').trim();
    return { result, currentTag, calls: loggedCalls() };
  }

  const index = (list: string[], needle: string) => list.findIndex((call) => call.includes(needle));
  const upWith = (list: string[], tag: string) =>
    list.some((call) => call.startsWith(`IMAGE_TAG=${tag} `) && call.includes('up -d web worker'));

  it('upgrades in the fixed order: backup → pull → migrate → start → health → record', () => {
    const { result, currentTag, calls: log } = startWith({});

    expect(result.status).toBe(0);
    expect(index(log, 'backup')).toBeLessThan(index(log, 'docker pull'));
    expect(index(log, 'docker pull')).toBeLessThan(index(log, 'dist/migrate.js'));
    expect(index(log, 'dist/migrate.js')).toBeLessThan(index(log, 'up -d web worker'));
    expect(upWith(log, 'local-0123456789ab')).toBe(true);
    expect(currentTag).toBe('local-0123456789ab');
  });

  it('a failed backup aborts before pulling and starts the current image', () => {
    const { result, currentTag, calls: log } = startWith({ backupExit: 1 });

    expect(result.status).toBe(1);
    expect(index(log, 'docker pull')).toBe(-1);
    expect(index(log, 'dist/migrate.js')).toBe(-1);
    expect(upWith(log, 'local-current')).toBe(true);
    expect(currentTag).toBe('local-current');
  });

  it('a failed migration keeps the current image and records nothing new', () => {
    const { result, currentTag, calls: log } = startWith({ migrateExit: 1 });

    expect(result.status).toBe(1);
    expect(upWith(log, 'local-current')).toBe(true);
    expect(upWith(log, 'local-0123456789ab')).toBe(false);
    expect(currentTag).toBe('local-current');
  });

  it('a failed health check restarts the last-known-good image', () => {
    const { result, currentTag, calls: log } = startWith({ healthExit: 1 });

    expect(result.status).toBe(1);
    expect(index(log, 'IMAGE_TAG=local-0123456789ab docker compose')).toBeLessThan(
      log.map((call) => call.startsWith('IMAGE_TAG=local-lastgood ')).lastIndexOf(true),
    );
    expect(upWith(log, 'local-lastgood')).toBe(true);
    expect(currentTag).toBe('local-current');
  });

  it('starts the current image when the registry is unreachable, without a pull or a migration', () => {
    const { result, calls: log } = startWith({ offline: true });

    expect(result.status).toBe(0);
    expect(index(log, 'docker pull')).toBe(-1);
    expect(index(log, 'dist/migrate.js')).toBe(-1);
    expect(upWith(log, 'local-current')).toBe(true);
  });
});

describe('init.sh (BR-021-36)', () => {
  it('refuses to initialise with FileVault off, creating nothing', () => {
    const fdesetup = stub('fdesetup', 'echo "FileVault is Off."');
    const uname = stub('uname', 'echo Darwin');
    const docker = stub('docker', `echo "docker $*" >> "${calls}"`);
    const envPath = join(sandbox, 'config', 'personal.env');

    const result = run('init.sh', {
      FDESETUP: fdesetup,
      UNAME: uname,
      DOCKER: docker,
      ALLMYWALLET_ENV_FILE: envPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FileVault');
    expect(loggedCalls()).toEqual([]);
    expect(() => readFileSync(envPath)).toThrow();
  });

  it('refuses an env file inside the repository', () => {
    const fdesetup = stub('fdesetup', 'echo "FileVault is On."');
    const uname = stub('uname', 'echo Darwin');

    const result = run('init.sh', {
      FDESETUP: fdesetup,
      UNAME: uname,
      ALLMYWALLET_ENV_FILE: resolve('personal.env'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside the repository');
  });
});
