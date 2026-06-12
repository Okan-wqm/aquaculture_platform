import {
  assertRuntimeDdlAllowed,
  hasDbMigrateDdlAuthority,
  isSchemaDdlOwnedByDbMigrate,
  resolveDbMigrateAuthoritative,
  resolveDbMigrateAuthoritativeFromConfig,
} from '../db-migrate-authority.util';

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

  it('keeps isSchemaDdlOwnedByDbMigrate as the SAME resolver (alias, not a fork)', () => {
    // SSOT guard: the historical name must reference the same function
    // object so the strict-parse behaviour can never diverge between
    // the two names.
    expect(isSchemaDdlOwnedByDbMigrate).toBe(resolveDbMigrateAuthoritative);
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
});

describe('hasDbMigrateDdlAuthority', () => {
  it('is true only for the literal "1"', () => {
    expect(hasDbMigrateDdlAuthority({ DB_MIGRATE_DDL_AUTHORITY: '1' })).toBe(true);
    expect(hasDbMigrateDdlAuthority({ DB_MIGRATE_DDL_AUTHORITY: 'true' })).toBe(false);
    expect(hasDbMigrateDdlAuthority({})).toBe(false);
  });
});

describe('assertRuntimeDdlAllowed', () => {
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

  it('tags authority violations with the [db-migrate authority] marker', () => {
    // AuditColumnsBootstrap rethrows on this marker — wording is a
    // contract, not decoration.
    expect(() =>
      assertRuntimeDdlAllowed({
        serviceName: 'config',
        operation: 'audit columns',
        env: { NODE_ENV: 'production' },
      }),
    ).toThrow(/\[db-migrate authority\]/);
  });

  it('allows runtime DDL in non-authoritative local/test mode', () => {
    expect(() =>
      assertRuntimeDdlAllowed({
        serviceName: 'farm',
        operation: 'tenant RLS schema sync',
        env: { NODE_ENV: 'test' },
      }),
    ).not.toThrow();
  });

  it('allows DDL inside the db-migrate container even in authoritative mode', () => {
    // The hardening executor in apps/db-migrate reuses the same helpers
    // runtime services are barred from — DB_MIGRATE_DDL_AUTHORITY=1 is
    // its capability marker (set at entrypoint, forbidden elsewhere by
    // createServiceTypeOrmConfig).
    expect(() =>
      assertRuntimeDdlAllowed({
        serviceName: 'db-migrate',
        operation: 'post-migration hardening',
        env: {
          DB_MIGRATE_DDL_AUTHORITY: '1',
          DB_MIGRATE_AUTHORITATIVE: 'true',
          NODE_ENV: 'production',
        },
      }),
    ).not.toThrow();
  });
});
