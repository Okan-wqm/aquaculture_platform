import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';

import { UserSiteAssignment } from '../../modules/authentication/entities/user-site-assignment.entity';
import { User } from '../../modules/authentication/entities/user.entity';

import { EnforceUserSiteAssignmentTenantIdentity1807600000000 } from '../1807600000000-EnforceUserSiteAssignmentTenantIdentity';

function makeRunner(guardFailure?: Error): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const indexes = new Set<string>();
  const runner = {
    isTransactionActive: false,
    query: jest.fn((sql: string, params?: unknown[]): Promise<unknown> => {
      queries.push(sql);
      if (sql.includes('SELECT current_schema()')) {
        return Promise.resolve([{ current_schema: 'auth' }]);
      }
      if (guardFailure && sql.includes('mismatched or orphaned assignments exist')) {
        return Promise.reject(guardFailure);
      }
      if (sql.includes('FROM pg_class index_class')) {
        const indexName = params?.[1];
        if (typeof indexName !== 'string' || !indexes.has(indexName)) {
          return Promise.resolve([]);
        }
        const userUnique = indexName === 'UQ_users_id_tenant';
        return Promise.resolve([
          {
            columns: userUnique ? ['id', 'tenantId'] : ['userId', 'tenantId'],
            predicate: null,
            isUnique: userUnique,
            isValid: true,
            isReady: true,
            hasExpressions: false,
            method: 'btree',
          },
        ]);
      }
      if (sql.startsWith('CREATE UNIQUE INDEX CONCURRENTLY')) {
        indexes.add('UQ_users_id_tenant');
      }
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
        indexes.add('IDX_user_site_assignments_user_tenant');
      }
      return Promise.resolve([]);
    }),
  } as never;
  return { runner, queries };
}

describe('EnforceUserSiteAssignmentTenantIdentity1807600000000', () => {
  it('keeps entity metadata in parity with the composite identity DDL', () => {
    const metadata = getMetadataArgsStorage();
    const userIdentity = metadata.uniques.find(
      (unique) => unique.target === User && unique.name === 'UQ_users_id_tenant',
    );
    const assignmentIdentities = metadata.uniques.filter(
      (unique) => unique.target === UserSiteAssignment,
    );
    const assignmentLookup = metadata.indices.find(
      (index) =>
        index.target === UserSiteAssignment &&
        index.name === 'IDX_user_site_assignments_user_tenant',
    );
    const userJoinColumns = metadata.joinColumns.filter(
      (joinColumn) =>
        joinColumn.target === UserSiteAssignment && joinColumn.propertyName === 'user',
    );

    expect(userIdentity?.columns).toEqual(['id', 'tenantId']);
    expect(assignmentIdentities).toEqual([
      expect.objectContaining({ name: 'UQ_user_site', columns: ['userId', 'siteId'] }),
    ]);
    expect(assignmentLookup?.columns).toEqual(['userId', 'tenantId']);
    expect(userJoinColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'userId', referencedColumnName: 'id' }),
        expect.objectContaining({ name: 'tenantId', referencedColumnName: 'tenantId' }),
      ]),
    );
  });

  it('fails closed before DDL when a mismatched assignment exists', async () => {
    const guardFailure = new Error('mismatched assignment');
    const { runner, queries } = makeRunner(guardFailure);
    const migration = new EnforceUserSiteAssignmentTenantIdentity1807600000000();

    await expect(migration.up(runner)).rejects.toBe(guardFailure);

    expect(queries.some((sql) => /^\s*DELETE\b/i.test(sql))).toBe(false);
    expect(queries.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(false);
    const guardQuery = queries.find((sql) => sql.includes('mismatched or orphaned assignments'));
    expect(guardQuery).toContain('IF EXISTS');
    expect(guardQuery).toContain('RAISE EXCEPTION');
  });

  it('installs a composite user/tenant identity without destructive repair', async () => {
    const { runner, queries } = makeRunner();
    const migration = new EnforceUserSiteAssignmentTenantIdentity1807600000000();

    await migration.up(runner);

    const migrationSql = queries.join('\n');
    expect(queries.some((sql) => /^\s*DELETE\b/i.test(sql))).toBe(false);
    expect(migrationSql).toContain('USING btree ("id", "tenantId")');
    expect(migrationSql).toContain('UNIQUE USING INDEX "UQ_users_id_tenant"');
    expect(migrationSql).toContain('FOREIGN KEY ("userId", "tenantId")');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migration.transaction).toBe(false);
    expect(migrationSql).not.toContain('UQ_user_site_tenant');
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT(?: IF EXISTS)? "UQ_user_site"/);
    expect(migrationSql.indexOf('RAISE EXCEPTION')).toBeLessThan(
      migrationSql.indexOf('ADD CONSTRAINT "UQ_users_id_tenant"'),
    );
  });

  it('does not add a redundant tenant-suffixed assignment uniqueness constraint', async () => {
    const { runner, queries } = makeRunner();
    const migration = new EnforceUserSiteAssignmentTenantIdentity1807600000000();

    await migration.up(runner);

    const migrationSql = queries.join('\n');
    expect(migrationSql).not.toContain('UQ_user_site_tenant');
    expect(migrationSql).not.toMatch(/DROP CONSTRAINT(?: IF EXISTS)? "UQ_user_site"/);
  });

  it('restores legacy constraints in dependency-safe down order', async () => {
    const { runner, queries } = makeRunner();
    const migration = new EnforceUserSiteAssignmentTenantIdentity1807600000000();

    await migration.down(runner);

    const sql = queries.join('\n');
    const restoreLegacyFk = sql.indexOf('ADD CONSTRAINT "FK_user_site_assignments_user"');
    const dropCompositeFk = sql.indexOf('FK_user_site_assignments_user_tenant');
    const dropIndex = sql.indexOf(
      'DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_user_site_assignments_user_tenant"',
    );
    const dropUserCompositeUnique = sql.indexOf('DROP CONSTRAINT IF EXISTS "UQ_users_id_tenant"');

    expect(restoreLegacyFk).toBeGreaterThanOrEqual(0);
    expect(restoreLegacyFk).toBeLessThan(dropCompositeFk);
    expect(dropCompositeFk).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(dropUserCompositeUnique);
    expect(sql).not.toContain('UQ_user_site_tenant');
    expect(sql).not.toContain('ADD CONSTRAINT "UQ_user_site"');
  });
});
