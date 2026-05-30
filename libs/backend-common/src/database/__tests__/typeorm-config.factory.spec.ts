import { ConfigService } from '@nestjs/config';

import { createServiceTypeOrmConfig } from '../typeorm-config.factory';

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
}

describe('createServiceTypeOrmConfig authoritative DDL guard', () => {
  it('rejects migrationsRun=true before TypeORM DataSource init', () => {
    expect(() =>
      createServiceTypeOrmConfig(
        config({
          DB_MIGRATE_AUTHORITATIVE: 'true',
          NODE_ENV: 'production',
          DATABASE_PASSWORD: 'secret',
        }),
        {
          serviceName: 'config',
          schema: 'config',
          migrations: [],
          migrationsRunFromEnv: () => true,
        },
      ),
    ).toThrow(/migrationsRun=true is incompatible/i);
  });

  it('rejects DATABASE_SYNC=true in authoritative mode', () => {
    expect(() =>
      createServiceTypeOrmConfig(
        config({
          DB_MIGRATE_AUTHORITATIVE: 'true',
          NODE_ENV: 'production',
          DATABASE_PASSWORD: 'secret',
          DATABASE_SYNC: 'true',
        }),
        {
          serviceName: 'event-store',
          schema: 'event_store',
          migrations: [],
        },
      ),
    ).toThrow(/DATABASE_SYNC=true is incompatible/i);
  });

  it('allows local migration execution when authoritative mode is off', () => {
    const out = createServiceTypeOrmConfig(
      config({
        DB_MIGRATE_AUTHORITATIVE: 'false',
        NODE_ENV: 'development',
        DATABASE_SYNC: 'false',
      }),
      {
        serviceName: 'farm',
        schema: 'farm',
        migrations: [],
        migrationsRunFromEnv: () => true,
      },
    );

    expect(out.migrationsRun).toBe(true);
  });
});
