import { TenantRlsService } from './tenant-rls.service';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

describe('TenantRlsService', () => {
  let service: TenantRlsService;
  let mockDataSource: jest.Mocked<DataSource>;
  let mockEntityManager: jest.Mocked<EntityManager>;
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    mockEntityManager = {
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EntityManager>;

    mockQueryRunner = {
      query: jest.fn().mockResolvedValue(undefined),
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<QueryRunner>;

    mockDataSource = {
      query: jest.fn().mockResolvedValue(undefined),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    } as unknown as jest.Mocked<DataSource>;

    service = new TenantRlsService(mockDataSource);
  });

  describe('SQL identifier validation', () => {
    it('should accept valid SQL identifiers', () => {
      expect(() => service.generateEnableRlsSql('myschema', 'users')).not.toThrow();
      expect(() => service.generateEnableRlsSql('tenant_data', 'user_profiles')).not.toThrow();
      expect(() => service.generateEnableRlsSql('_private', 'table1')).not.toThrow();
    });

    it('should reject identifiers with special characters', () => {
      expect(() => service.generateEnableRlsSql('my;schema', 'users')).toThrow(/Invalid SQL identifier/);
      expect(() => service.generateEnableRlsSql('schema', 'users; DROP TABLE')).toThrow(/Invalid SQL identifier/);
    });

    it('should reject identifiers starting with numbers', () => {
      expect(() => service.generateEnableRlsSql('1schema', 'users')).toThrow(/Invalid SQL identifier/);
    });

    it('should reject empty identifiers', () => {
      expect(() => service.generateEnableRlsSql('', 'users')).toThrow(/Invalid SQL identifier/);
      expect(() => service.generateEnableRlsSql('schema', '')).toThrow(/Invalid SQL identifier/);
    });

    it('should reject identifiers with spaces', () => {
      expect(() => service.generateEnableRlsSql('my schema', 'users')).toThrow(/Invalid SQL identifier/);
    });

    it('should reject identifiers with SQL injection attempts', () => {
      expect(() => service.generateEnableRlsSql("schema' OR '1'='1", 'users')).toThrow(/Invalid SQL identifier/);
      expect(() => service.generateEnableRlsSql('schema', 'users--comment')).toThrow(/Invalid SQL identifier/);
    });
  });

  describe('generateEnableRlsSql', () => {
    it('should generate correct ENABLE RLS statement', () => {
      const sql = service.generateEnableRlsSql('public', 'users');
      expect(sql).toBe('ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY');
    });

    it('should quote schema and table names', () => {
      const sql = service.generateEnableRlsSql('tenant_data', 'user_profiles');
      expect(sql).toContain('"tenant_data"');
      expect(sql).toContain('"user_profiles"');
    });
  });

  describe('generateCreatePolicySql', () => {
    it('should generate correct CREATE POLICY statement with default column', () => {
      const sql = service.generateCreatePolicySql('public', 'users');
      expect(sql).toContain('CREATE POLICY');
      expect(sql).toContain('"public"."users"');
      expect(sql).toContain('"tenantId"');
      expect(sql).toContain('current_setting');
    });

    it('should use custom tenantId column name', () => {
      const sql = service.generateCreatePolicySql('public', 'users', 'tenant_id');
      expect(sql).toContain('"tenant_id"');
    });

    it('should generate a unique policy name based on schema and table', () => {
      const sql = service.generateCreatePolicySql('public', 'users');
      expect(sql).toContain('tenant_isolation_public_users');
    });

    it('should reject invalid column names', () => {
      expect(() => service.generateCreatePolicySql('public', 'users', 'col; DROP')).toThrow(/Invalid SQL identifier/);
    });
  });

  describe('setTenantContext', () => {
    it('should set tenant context using SET LOCAL', async () => {
      const tenantId = '550e8400-e29b-41d4-a716-446655440000';
      await service.setTenantContext(mockEntityManager, tenantId);
      expect(mockEntityManager.query).toHaveBeenCalledWith(
        expect.stringContaining('SET LOCAL'),
        expect.anything(),
      );
    });

    it('should use set_config with is_local=true for transaction scoping', async () => {
      const tenantId = '550e8400-e29b-41d4-a716-446655440000';
      await service.setTenantContext(mockEntityManager, tenantId);
      expect(mockEntityManager.query).toHaveBeenCalledWith(
        expect.stringContaining('set_config'),
        expect.arrayContaining([tenantId]),
      );
    });

    it('should reject invalid tenant ID', async () => {
      await expect(
        service.setTenantContext(mockEntityManager, 'not-a-uuid'),
      ).rejects.toThrow(/valid UUID/);
    });

    it('should reject empty tenant ID', async () => {
      await expect(
        service.setTenantContext(mockEntityManager, ''),
      ).rejects.toThrow(/valid UUID/);
    });
  });

  describe('enableRls', () => {
    it('should execute ENABLE RLS and CREATE POLICY', async () => {
      await service.enableRls('public', 'users');
      expect(mockDataSource.query).toHaveBeenCalledTimes(2);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('ENABLE ROW LEVEL SECURITY'),
      );
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('CREATE POLICY'),
      );
    });

    it('should handle "already exists" errors gracefully', async () => {
      const alreadyExistsError = new Error('policy "tenant_isolation_public_users" for table "users" already exists');
      (alreadyExistsError as any).code = '42710'; // duplicate_object
      mockDataSource.query
        .mockResolvedValueOnce(undefined) // ENABLE RLS succeeds
        .mockRejectedValueOnce(alreadyExistsError); // CREATE POLICY already exists

      // Should not throw
      await expect(service.enableRls('public', 'users')).resolves.not.toThrow();
    });

    it('should re-throw non-duplicate errors', async () => {
      const otherError = new Error('permission denied');
      mockDataSource.query.mockRejectedValueOnce(otherError);

      await expect(service.enableRls('public', 'users')).rejects.toThrow('permission denied');
    });

    it('should handle "already enabled" RLS errors gracefully', async () => {
      // Some PG versions might report RLS already enabled differently
      const alreadyEnabledError = new Error('row level security already enabled');
      (alreadyEnabledError as any).code = '42710';
      mockDataSource.query
        .mockRejectedValueOnce(alreadyEnabledError);

      await expect(service.enableRls('public', 'users')).resolves.not.toThrow();
    });
  });

  describe('forceRls', () => {
    it('should generate FORCE RLS statement', () => {
      const sql = service.generateForceRlsSql('public', 'users');
      expect(sql).toBe('ALTER TABLE "public"."users" FORCE ROW LEVEL SECURITY');
    });
  });
});
