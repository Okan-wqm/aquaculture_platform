import { createMockDataSource } from '@platform/testing';

import { RlsSchemaBootstrap } from './rls-schema-bootstrap.service';

/**
 * Authority choke-point tests for `RlsSchemaBootstrap`
 * (PR#363 reimplement-port, DATA-HIGH-004).
 *
 * The bootstrap is one of the runtime DDL choke-points: in authoritative
 * mode (`DB_MIGRATE_AUTHORITATIVE=true`) it must fail the boot BEFORE a
 * QueryRunner is opened — RLS hardening belongs to
 * `SCHEMA_REGISTRY.postMigrationHardening` in aqua-db-migrate.
 */
describe('RlsSchemaBootstrap — db-migrate authority choke-point', () => {
  const originalAuthoritative = process.env['DB_MIGRATE_AUTHORITATIVE'];

  afterEach(() => {
    if (originalAuthoritative === undefined) {
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_AUTHORITATIVE');
    } else {
      process.env['DB_MIGRATE_AUTHORITATIVE'] = originalAuthoritative;
    }
  });

  it('fails fast in authoritative mode without opening a QueryRunner', async () => {
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';
    const { mockDataSource } = createMockDataSource();
    const bootstrap = new RlsSchemaBootstrap(mockDataSource, {
      serviceName: 'billing',
    });

    await expect(bootstrap.onApplicationBootstrap()).rejects.toThrow(/Runtime DDL operation/i);
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('disabled flag short-circuits before the authority assertion', async () => {
    // Staged-rollout contract: `disabled: true` is an explicit operator
    // decision and must remain a silent no-op even in authoritative mode.
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'true';
    const { mockDataSource } = createMockDataSource();
    const bootstrap = new RlsSchemaBootstrap(mockDataSource, {
      serviceName: 'billing',
      disabled: true,
    });

    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('keeps the non-authoritative log-and-continue contract', async () => {
    // In local/dev mode the bootstrap passes the choke-point, opens a
    // runner, and the helper-level DDL-authority guard (which requires
    // the db-migrate capability env) refuses — the bootstrap logs
    // rls.bootstrap.failed and the service still boots.
    process.env['DB_MIGRATE_AUTHORITATIVE'] = 'false';
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    const bootstrap = new RlsSchemaBootstrap(mockDataSource, {
      serviceName: 'billing',
    });

    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(mockDataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
  });
});
