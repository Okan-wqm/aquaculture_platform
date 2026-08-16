import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { RestoreConfigSchemaOwnerBoundary1807400000000 } from '../1807400000000-RestoreConfigSchemaOwnerBoundary';

describe('RestoreConfigSchemaOwnerBoundary1807400000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT current_schema()')) {
        return Promise.resolve([{ current_schema: 'config' }]);
      }
      return Promise.resolve([]);
    });
  });

  it('fails closed on a missing owner authority and restores only schema ownership', async () => {
    await new RestoreConfigSchemaOwnerBoundary1807400000000().up(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("rolname = 'config_schema_owner'");
    expect(sql).toContain('AND NOT rolcanlogin');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('ALTER SCHEMA config OWNER TO config_schema_owner');
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA config TO config_service');
    expect(sql).not.toContain('ALTER TABLE');
  });

  it('requires the exact owner/runtime separation and both RLS-managed table owners', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT current_schema()')) {
        return Promise.resolve([{ current_schema: 'config' }]);
      }
      if (statement.includes('WITH roles AS')) {
        return Promise.resolve([{ ok: true }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      new RestoreConfigSchemaOwnerBoundary1807400000000().postCondition(queryRunner),
    ).resolves.toBe(true);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("pg_get_userbyid(nspowner) = 'config_schema_owner'");
    expect(sql).toContain("pg_has_role(runtime_oid, owner_oid, 'MEMBER')");
    expect(sql).toContain("c.relname IN ('configurations', 'configuration_history')");
    expect(sql).toContain("owner_name <> 'config_service'");
  });

  it('rejects a false database post-condition instead of treating it as evidence', async () => {
    queryRunner.query.mockResolvedValue([{ ok: false }]);

    await expect(
      new RestoreConfigSchemaOwnerBoundary1807400000000().postCondition(queryRunner),
    ).resolves.toBe(false);
  });
});
