import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One exact Node version for every place the project runs.
 *
 * `package.json`'s `devEngines.runtime` is the source: pnpm downloads that
 * version and runs every script with it, whatever the shell's `node` is. The
 * Docker image — where the personal instance runs `node dist/migrate.js` and
 * `node dist/ops.js` outside pnpm — and CI's `setup-node` are pinned to the
 * same version, and `engines` states it.
 *
 * The gap this closes (2026-10-28, #269): `undici` 8.12 needs Node ≥ 22.19, so
 * the owner's Node 23.6 failed every integration suite at import while CI, on
 * a floating `'22'`, passed. Three floating versions could each drift from the
 * one the gate ran on.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const manifest = JSON.parse(read('package.json')) as {
  engines?: { node?: string };
  devEngines?: { runtime?: { name?: string; version?: string; onFail?: string } };
};
const pinned = manifest.devEngines?.runtime?.version ?? '';

describe('the Node version is pinned once and used everywhere', () => {
  it('is an exact version pnpm downloads when it is missing', () => {
    expect(manifest.devEngines?.runtime).toMatchObject({ name: 'node', onFail: 'download' });
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is the version engines states', () => {
    expect(manifest.engines?.node).toBe(pinned);
  });

  it('is the Docker base image, by exact tag and digest', () => {
    const from = read('Dockerfile').match(/^FROM node:(\S+) AS base$/m)?.[1];
    expect(from).toMatch(
      new RegExp(`^${pinned.replaceAll('.', '\\.')}-alpine@sha256:[0-9a-f]{64}$`),
    );
  });

  it.each(['ci.yml', 'nightly.yml', 'deploy.yml'])("is %s's NODE_VERSION", (workflow) => {
    const version = read(`.github/workflows/${workflow}`).match(
      /^ {2}NODE_VERSION: '([^']+)'$/m,
    )?.[1];
    expect(version).toBe(pinned);
  });
});
