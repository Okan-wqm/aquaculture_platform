import {
  assertRuntimeDdlAllowed,
  resolveDbMigrateAuthoritative,
  resolveDbMigrateAuthoritativeFromConfig,
} from '../db-migrate-authority';

describe('db-migrate authority resolver', () => {
  it('honours explicit DB_MIGRATE_AUTHORITATIVE=true', () => {
    expect(
      resolveDbMigrateAuthoritative({
        DB_MIGRATE_AUTHORITATIVE: 'true',
        NODE_ENV: 'development',
      }),
    ).toBe(true);
  });

  it('honours explicit DB_MIGRATE_AUTHORITATIVE=false in production', () => {
    expect(
      resolveDbMigrateAuthoritative({
        DB_MIGRATE_AUTHORITATIVE: 'false',
        NODE_ENV: 'production',
      }),
    ).toBe(false);
  });

  it('defaults production and staging to authoritative', () => {
    expect(resolveDbMigrateAuthoritative({ NODE_ENV: 'production' })).toBe(true);
    expect(
      resolveDbMigrateAuthoritative({
        NODE_ENV: 'development',
        AQUA_ENV: 'staging',
      }),
    ).toBe(true);
  });

  it('defaults development and test to runtime-friendly mode', () => {
    expect(resolveDbMigrateAuthoritative({ NODE_ENV: 'development' })).toBe(false);
    expect(resolveDbMigrateAuthoritative({ NODE_ENV: 'test' })).toBe(false);
  });

  it('rejects malformed explicit values', () => {
    expect(() =>
      resolveDbMigrateAuthoritative({
        DB_MIGRATE_AUTHORITATIVE: 'yes',
        NODE_ENV: 'production',
      }),
    ).toThrow(/must be either "true" or "false"/i);
  });

  it('can resolve from ConfigService-like readers', () => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, string> = {
          NODE_ENV: 'development',
          AQUA_ENV: 'production',
        };
        return values[key] ?? fallback;
      }),
    } as Parameters<typeof resolveDbMigrateAuthoritativeFromConfig>[0];
    expect(resolveDbMigrateAuthoritativeFromConfig(config)).toBe(true);
  });

  it('blocks runtime DDL in authoritative mode', () => {
    expect(() =>
      assertRuntimeDdlAllowed({
        serviceName: 'billing',
        operation: 'audit columns',
        env: {
          DB_MIGRATE_AUTHORITATIVE: 'true',
          NODE_ENV: 'production',
        },
      }),
    ).toThrow(/runtime ddl operation/i);
  });
});
