import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '@/lib/env';

const VALID_URL = 'postgresql://allmywallet_app:secret@localhost:5432/allmywallet';

describe('env', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    resetEnvCache();
  });

  afterEach(() => {
    process.env = original;
    resetEnvCache();
  });

  it('parses a valid environment', () => {
    process.env.DATABASE_URL = VALID_URL;
    Reflect.deleteProperty(process.env, 'LOG_LEVEL');
    const parsed = env();
    expect(parsed.DATABASE_URL).toBe(VALID_URL);
    expect(parsed.LOG_LEVEL).toBe('info');
  });

  it('defaults NODE_ENV only when it is genuinely unset', () => {
    // Vitest sets NODE_ENV=test, so the default is asserted against an
    // explicitly cleared environment rather than against the runner's.
    process.env.DATABASE_URL = VALID_URL;
    expect(env().NODE_ENV).toBe('test');

    resetEnvCache();
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    expect(env().NODE_ENV).toBe('development');
  });

  it('fails the boot rather than defaulting to localhost', () => {
    // Same reasoning as BR-002-04: a missing DATABASE_URL that quietly becomes
    // a local database is a worse outcome than not starting, because it starts.
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it('names the offending key in the failure message', () => {
    process.env.DATABASE_URL = 'not-a-url';
    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it('rejects an AUTH_SECRET too short to be one', () => {
    process.env.DATABASE_URL = VALID_URL;
    process.env.AUTH_SECRET = 'short';
    expect(() => env()).toThrow(/AUTH_SECRET/);
  });

  it('rejects an AUTH_URL that is not a URL', () => {
    // #42: this value becomes the origin every callback URL is built from. A
    // bare hostname parses as "not a URL" here rather than reaching Auth.js
    // and failing per-request, which is the whole point of validating it.
    process.env.DATABASE_URL = VALID_URL;
    process.env.AUTH_URL = 'allmywallet.example.com';
    expect(() => env()).toThrow(/AUTH_URL/);
  });

  it('rejects an unknown log level instead of falling back', () => {
    process.env.DATABASE_URL = VALID_URL;
    process.env.LOG_LEVEL = 'verbose';
    expect(() => env()).toThrow(/LOG_LEVEL/);
  });

  it('caches, so the parse cost is paid once per process', () => {
    process.env.DATABASE_URL = VALID_URL;
    expect(env()).toBe(env());
  });

  it('treats the migration URL as optional — it is absent at runtime by design', () => {
    process.env.DATABASE_URL = VALID_URL;
    Reflect.deleteProperty(process.env, 'DATABASE_MIGRATION_URL');
    expect(env().DATABASE_MIGRATION_URL).toBeUndefined();
  });
});
