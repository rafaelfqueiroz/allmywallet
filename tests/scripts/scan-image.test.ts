import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SPEC-021 BR-021-14 — scripts/ci/scan-image.sh against real images built
 * here from `scratch`, so no base image is pulled. The planted secrets are
 * assembled at runtime: a key-shaped literal committed to this repository
 * would be the very thing the scan exists to keep out of it.
 *
 * The key-shaped check once never ran at all — its pattern began with
 * `-----BEGIN` and grep took it for an option, with the error swallowed — so
 * every image passed. This file is what would have caught that.
 */
const hasDocker = spawnSync('docker', ['version'], { encoding: 'utf-8' }).status === 0;

const PRIVATE_KEY_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const GITHUB_TOKEN = ['ghp', '_', 'a'.repeat(36)].join('');

describe.skipIf(!hasDocker)('scan-image.sh (SPEC-021 BR-021-14)', () => {
  let dir: string;
  const tags: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'amw-scan-'));
  });

  afterAll(() => {
    if (tags.length > 0) spawnSync('docker', ['image', 'rm', '-f', ...tags]);
    rmSync(dir, { recursive: true, force: true });
  });

  function imageWith(name: string, files: Record<string, string>): string {
    const context = join(dir, name);
    mkdirSync(join(context, 'payload'), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(context, 'payload', path), content);
    }
    writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY payload/ /app/\n');
    const tag = `amw-scan-test-${name}:${process.pid}`;
    const build = spawnSync('docker', ['build', '-q', '-t', tag, context], { encoding: 'utf-8' });
    expect(build.status, build.stderr).toBe(0);
    tags.push(tag);
    return tag;
  }

  function scan(tag: string) {
    return spawnSync('bash', [resolve('scripts/ci/scan-image.sh'), tag], { encoding: 'utf-8' });
  }

  it('passes an image carrying nothing secret-shaped', () => {
    const result = scan(imageWith('clean', { 'server.js': 'console.log("hello");\n' }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no secret or personal data found');
  }, 120_000);

  it('fails an image carrying a private key header', () => {
    const result = scan(
      imageWith('private-key', { 'config.js': `const key = "${PRIVATE_KEY_HEADER}\\nMII";\n` }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('key-shaped: ');
    expect(result.stderr).toContain('config.js');
  }, 120_000);

  it('fails an image carrying a GitHub token', () => {
    const result = scan(imageWith('token', { 'settings.json': `{"token":"${GITHUB_TOKEN}"}\n` }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('settings.json');
  }, 120_000);

  it('fails an image carrying a spreadsheet, by name', () => {
    const result = scan(imageWith('xlsx', { 'extrato.xlsx': 'not really a spreadsheet\n' }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('name: ');
    expect(result.stderr).toContain('extrato.xlsx');
  }, 120_000);
});
