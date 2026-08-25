import { ConfigService } from '@nestjs/config';

import { createServiceTypeOrmConfig } from '../typeorm-config.factory';

/**
 * Authoritative DDL guard tests for `createServiceTypeOrmConfig`
 * (PR#363 reimplement-port).
 *
 * WHY env-based setup instead of a stubbed ConfigService: the factory
 * deliberately reads `process.env['NODE_ENV']` directly (fail-fast even
 * when ConfigModule wiring is forgotten), and `@nestjs/config` resolves
 * `process.env` BEFORE the internal config object — so the honest way to
 * exercise the guard is through the real environment, saved/restored per
 * test. This also avoids any cast on the ConfigService boundary.
 */
describe('createServiceTypeOrmConfig authoritative DDL guard', () => {
  const MANAGED_KEYS = [
    'DB_MIGRATE_AUTHORITATIVE',
    'DB_MIGRATE_DDL_AUTHORITY',
    'DATABASE_SYNC',
    'AQUA_ENV',
  ] as const;
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      original.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const value = original.get(key);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it('rejects migrationsRun=true before TypeORM DataSource init in authoritative mode', () => {
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';

    expect(() =>
      createServiceTypeOrmConfig(new ConfigService(), {
        serviceName: 'config',
        schema: 'config',
        migrations: [],
        migrationsRunFromEnv: () => true,
      }),
    ).toThrow(/migrationsRun=true is not allowed/i);
  });

  it('rejects DATABASE_SYNC=true in every runtime mode', () => {
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'false';
    process.env['DATABASE_SYNC'] = 'true';

    expect(() =>
      createServiceTypeOrmConfig(new ConfigService(), {
        serviceName: 'event-store',
        schema: 'event_store',
        migrations: [],
      }),
    ).toThrow(/DATABASE_SYNC=true is retired/i);
  });

  it('rejects DB_MIGRATE_DDL_AUTHORITY=1 leaking into a runtime service', () => {
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';

    expect(() =>
      createServiceTypeOrmConfig(new ConfigService(), {
        serviceName: 'farm',
        schema: 'farm',
        migrations: [],
      }),
    ).toThrow(/only valid inside aqua-db-migrate/i);
  });

  it('rejects malformed DB_MIGRATE_AUTHORITATIVE values (strict parse, no silent default)', () => {
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'yes';

    expect(() =>
      createServiceTypeOrmConfig(new ConfigService(), {
        serviceName: 'billing',
        schema: 'billing',
        migrations: [],
      }),
    ).toThrow(/must be either "true" or "false"/i);
  });

  it('allows local migration execution when authoritative mode is off', () => {
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'false';

    const out = createServiceTypeOrmConfig(new ConfigService(), {
      serviceName: 'farm',
      schema: 'farm',
      migrations: [],
      migrationsRunFromEnv: () => true,
    });

    expect(out.migrationsRun).toBe(true);
    expect(out.synchronize).toBe(false);
  });

  it('lets a latency-critical service lower the pool acquisition deadline', () => {
    const out = createServiceTypeOrmConfig(new ConfigService(), {
      serviceName: 'sensor',
      schema: 'sensor',
      migrations: [],
      defaultPoolConnectionTimeoutMs: 2_000,
    });

    expect(out.extra).toMatchObject({ connectionTimeoutMillis: 2_000 });
  });
});
