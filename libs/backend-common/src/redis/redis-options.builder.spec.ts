import { ConfigService } from '@nestjs/config';

import { buildRedisOptions } from './redis-options.builder';

type RedisConfigFixture = Record<string, string | number | undefined>;

function config(values: RedisConfigFixture): ConfigService<RedisConfigFixture, false> {
  return new ConfigService<RedisConfigFixture, false>(values);
}

describe('buildRedisOptions', () => {
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

  it('preserves an explicit empty key prefix for services with owned key namespaces', () => {
    expect(
      buildRedisOptions(config({ REDIS_URL: 'redis://redis:6379' }), 'ai', 'optional', {
        keyPrefix: '',
      }),
    ).toEqual({
      url: 'redis://redis:6379',
      keyPrefix: '',
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
