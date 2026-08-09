import { ConfigService } from '@nestjs/config';

import { buildRedisOptions } from './redis-options.builder';

type RedisConfigFixture = Record<string, string | number | undefined>;

function config(values: RedisConfigFixture): ConfigService<RedisConfigFixture, false> {
  return new ConfigService<RedisConfigFixture, false>(values);
}

/**
 * Every REDIS_* key this builder reads. The list is explicit because the
 * failure it prevents is silent: `ConfigService.get()` consults `process.env`
 * BEFORE the object it was constructed with, so an ambient REDIS_URL — which
 * CI sets and a laptop usually does not — overrides the fixture and the test
 * exercises a configuration it never declared.
 *
 * This spec passed for as long as it existed and failed on its first CI run,
 * for exactly that reason (ORPHAN-CRITICAL-579: these tests had no runner).
 */
const REDIS_ENV_KEYS = ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_DB'];

describe('buildRedisOptions', () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of REDIS_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      // Reflect.deleteProperty rather than `delete process.env[key]`: the key
      // is computed, and no-dynamic-delete exists because a computed delete on
      // a typed object silently removes something the type system still
      // believes is there. process.env is the one place it is unavoidable, so
      // it goes through the reflective form that says so.
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it('uses REDIS_URL as the canonical URL-mode Redis config', () => {
    expect(
      buildRedisOptions(
        config({ REDIS_URL: 'redis://:secret@redis:6379/3' }),
        'messaging',
        'optional',
      ),
    ).toEqual({
      url: 'redis://:secret@redis:6379/3',
      keyPrefix: 'messaging:',
    });
  });

  it('derives the key prefix from the service name in URL mode', () => {
    expect(
      buildRedisOptions(config({ REDIS_URL: 'redis://redis:6379' }), 'ai', 'optional'),
    ).toEqual({
      url: 'redis://redis:6379',
      keyPrefix: 'ai:',
    });
  });

  it('supports granular Redis config when REDIS_URL is not set', () => {
    expect(
      buildRedisOptions(
        config({
          REDIS_HOST: 'redis',
          REDIS_PORT: '6380',
          REDIS_PASSWORD: 'secret',
          REDIS_DB: '3',
        }),
        'sensor-service',
        'optional',
      ),
    ).toEqual({
      host: 'redis',
      port: 6380,
      password: 'secret',
      db: 3,
      keyPrefix: 'sensor-service:',
    });
  });

  it('rejects mixed REDIS_URL and granular Redis env contracts', () => {
    expect(() =>
      buildRedisOptions(
        config({
          REDIS_URL: 'redis://redis:6379',
          REDIS_HOST: 'redis',
        }),
        'sensor-service',
        'optional',
      ),
    ).toThrow('REDIS_URL cannot be combined with REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB');
  });

  it('requires Redis config for required production services', () => {
    expect(() =>
      buildRedisOptions(config({ NODE_ENV: 'production' }), 'auth', 'required'),
    ).toThrow('Redis is required for auth in production');
  });
});
