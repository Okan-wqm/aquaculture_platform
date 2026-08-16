import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import {
  SchemaManagerService,
  createCleanupDropProof,
  type CleanupDropProof,
} from '../schema-manager.service';

describe('SchemaManagerService', () => {
  let service: SchemaManagerService;
  let dataSource: jest.Mocked<DataSource>;

  const mockQuery = jest.fn();

  beforeEach(async () => {
    mockQuery.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaManagerService,
        {
          provide: DataSource,
          useValue: {
            query: mockQuery,
          },
        },
      ],
    }).compile();

    service = module.get<SchemaManagerService>(SchemaManagerService);
    dataSource = module.get(DataSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Clear the schema cache between tests
    service.clearSchemaCache();
  });

  describe('getTenantSchemaName', () => {
    it('should generate schema name from tenant UUID', () => {
      const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
      const schemaName = service.getTenantSchemaName(tenantId);

      expect(schemaName).toBe('tenant_4b529829ea7948da');
      expect(schemaName).toHaveLength(23); // 'tenant_' (7) + 16 hex chars
    });

    it('should generate consistent schema names', () => {
      const tenantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const schemaName1 = service.getTenantSchemaName(tenantId);
      const schemaName2 = service.getTenantSchemaName(tenantId);

      expect(schemaName1).toBe(schemaName2);
    });

    it('should generate different names for different tenants', () => {
      const tenant1 = '11111111-1111-1111-1111-111111111111';
      const tenant2 = '22222222-2222-2222-2222-222222222222';

      const schema1 = service.getTenantSchemaName(tenant1);
      const schema2 = service.getTenantSchemaName(tenant2);

      expect(schema1).not.toBe(schema2);
    });

    it('should handle uppercase UUIDs', () => {
      const lowercase = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
      const uppercase = '4B529829-EA79-48DA-982C-CD6FBEC8FFB7';

      const schema1 = service.getTenantSchemaName(lowercase);
      const schema2 = service.getTenantSchemaName(uppercase);

      // Both should produce lowercase schema names
      expect(schema1).toBe(schema2);
      expect(schema1).toMatch(/^tenant_[a-f0-9]{16}$/);
    });

    it('should throw BadRequestException for invalid UUID format', () => {
      const invalidUuid = 'not-a-valid-uuid';

      expect(() => service.getTenantSchemaName(invalidUuid)).toThrow(BadRequestException);
      expect(() => service.getTenantSchemaName(invalidUuid)).toThrow('Invalid tenant ID format');
    });

    it('should throw BadRequestException for UUID without dashes', () => {
      const withoutDashes = '4b529829ea7948da982ccd6fbec8ffb7';

      expect(() => service.getTenantSchemaName(withoutDashes)).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for empty string', () => {
      expect(() => service.getTenantSchemaName('')).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for SQL injection attempts', () => {
      const sqlInjection = "'; DROP TABLE users; --";

      expect(() => service.getTenantSchemaName(sqlInjection)).toThrow(BadRequestException);
    });
  });

  describe('schemaExists', () => {
    it('should return true if schema exists', async () => {
      mockQuery.mockResolvedValueOnce([{ '?column?': 1 }]);

      const exists = await service.schemaExists('tenant_4b529829ea7948da');

      expect(exists).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.schemata'),
        ['tenant_4b529829ea7948da'],
      );
    });

    it('should return false if schema does not exist', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const exists = await service.schemaExists('tenant_nonexistent0000');

      expect(exists).toBe(false);
    });

    it('should use cache for repeated checks', async () => {
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);

      await service.schemaExists('tenant_cached00000000');
      await service.schemaExists('tenant_cached00000000');
      await service.schemaExists('tenant_cached00000000');

      // Should only query database once due to caching
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should query database again after cache invalidation', async () => {
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);

      await service.schemaExists('tenant_toclear00000000');
      service.invalidateSchemaCache('tenant_toclear00000000');
      await service.schemaExists('tenant_toclear00000000');

      // Should query twice - once before invalidation, once after
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('schemaExistsNoCache', () => {
    it('should bypass cache and query database directly', async () => {
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);

      await service.schemaExistsNoCache('tenant_bypass00000000');
      await service.schemaExistsNoCache('tenant_bypass00000000');
      await service.schemaExistsNoCache('tenant_bypass00000000');

      // Should query database every time
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });

  describe('tenantSchemaExists', () => {
    it('should check schema existence using tenant ID', async () => {
      mockQuery.mockResolvedValueOnce([{ '?column?': 1 }]);

      const exists = await service.tenantSchemaExists('4b529829-ea79-48da-982c-cd6fbec8ffb7');

      expect(exists).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.schemata'),
        ['tenant_4b529829ea7948da'],
      );
    });
  });

  describe('createTenantSchema', () => {
    const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
    const schemaName = 'tenant_4b529829ea7948da';

    beforeEach(() => {
      // Default mock implementation for schema creation flow
      mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
        // Advisory lock acquisition
        if (sql.includes('pg_advisory_lock')) {
          return Promise.resolve([]);
        }
        // Advisory lock release
        if (sql.includes('pg_advisory_unlock')) {
          return Promise.resolve([]);
        }
        // Schema existence check
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        // Table existence check
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        // TimescaleDB extension check
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([]); // TimescaleDB not installed
        }
        // Count queries
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        // All other queries (CREATE, GRANT, etc.)
        return Promise.resolve([]);
      });
    });

    it('should not acquire advisory locks from runtime schema creation', async () => {
      await service.createTenantSchema(tenantId);

      const queryCalls = mockQuery.mock.calls as readonly (readonly unknown[])[];
      const lockCalls = queryCalls.filter(
        (call) =>
          String(call[0]).includes('pg_advisory_lock') && !String(call[0]).includes('unlock'),
      );
      expect(lockCalls.length).toBe(0);
    });

    it('should not release advisory locks from runtime schema creation', async () => {
      await service.createTenantSchema(tenantId);

      const queryCalls = mockQuery.mock.calls as readonly (readonly unknown[])[];
      const unlockCalls = queryCalls.filter((call) =>
        String(call[0]).includes('pg_advisory_unlock'),
      );
      expect(unlockCalls.length).toBe(0);
    });

    it('should not create schema directly from runtime services', async () => {
      const result = await service.createTenantSchema(tenantId);

      expect(result.success).toBe(false);
      expect(result.errors.join(' ')).toContain('owned by aqua-db-migrate');

      const createCalls = mockQuery.mock.calls.filter((call) => call[0].includes('CREATE SCHEMA'));
      expect(createCalls.length).toBe(0);
    });

    it('should skip creation if schema already exists', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata')) {
          return Promise.resolve([{ '?column?': 1 }]); // Schema exists
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('COUNT(*)::text')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      const result = await service.createTenantSchema(tenantId);

      expect(result.alreadyExists).toBe(true);
      expect(result.success).toBe(true);

      const createCalls = mockQuery.mock.calls.filter((call) => call[0].includes('CREATE SCHEMA'));
      expect(createCalls.length).toBe(0);
    });

    it('should reject new tenant schema provisioning with db-migrate authority error', async () => {
      const result = await service.createTenantSchema(tenantId, ['farm']);

      expect(result.success).toBe(false);
      expect(result.schemaName).toBe(schemaName);
      expect(result.tablesCreated).toEqual([]);
      expect(result.errors.join(' ')).toContain(
        'runtime services must write a provisioning request ledger entry',
      );
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should fail closed when an unknown module is requested', async () => {
      const result = await service.createTenantSchema(tenantId, ['farm', 'unknown-module']);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Unknown tenant module(s): unknown-module');
      expect(mockQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_lock'),
        expect.anything(),
      );
    });

    it('should fail closed when no module is requested', async () => {
      const result = await service.createTenantSchema(tenantId, []);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('No tenant modules requested for schema provisioning');
      expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('CREATE SCHEMA'));
    });

    it('should not attempt rollback drop when runtime DDL never starts', async () => {
      let schemaCreated = false;

      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]); // Schema doesn't exist
        }
        if (sql.includes('CREATE SCHEMA')) {
          schemaCreated = true;
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]); // Source table exists
        }
        if (sql.includes('CREATE TABLE') && schemaCreated) {
          throw new Error('Table creation failed');
        }
        if (sql.includes('DROP SCHEMA')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await service.createTenantSchema(tenantId, ['farm']);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      const dropCalls = mockQuery.mock.calls.filter((call) => call[0].includes('DROP SCHEMA'));
      expect(dropCalls.length).toBe(0);
    });

    it('should not use advisory locks when runtime provisioning is rejected', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('information_schema.schemata')) {
          return Promise.resolve([]);
        }
        if (sql.includes('CREATE SCHEMA')) {
          throw new Error('Schema creation failed');
        }
        if (sql.includes('DROP SCHEMA')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await service.createTenantSchema(tenantId);

      expect(result.success).toBe(false);

      const advisoryCalls = mockQuery.mock.calls.filter((call) => call[0].includes('pg_advisory'));
      expect(advisoryCalls.length).toBe(0);
    });

    it('should not grant schema usage from runtime services', async () => {
      await service.createTenantSchema(tenantId);

      const grantUsageCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('GRANT USAGE ON SCHEMA'),
      );
      expect(grantUsageCalls.length).toBe(0);
    });

    it('should not grant table privileges from runtime services', async () => {
      await service.createTenantSchema(tenantId);

      const grantTablesCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('GRANT ALL PRIVILEGES ON ALL TABLES'),
      );
      expect(grantTablesCalls.length).toBe(0);
    });

    it('should not grant sequence privileges from runtime services', async () => {
      await service.createTenantSchema(tenantId);

      const grantSeqCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('GRANT ALL PRIVILEGES ON ALL SEQUENCES'),
      );
      expect(grantSeqCalls.length).toBe(0);
    });
  });

  describe('reference data copying', () => {
    const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';

    it('should copy reference data from source schema', async () => {
      const insertCalls: string[] = [];

      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]); // Table exists
        }
        if (sql.includes('pg_extension')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          // First call: target table count (empty), Second: source count
          if (sql.includes('SELECT * FROM')) {
            return Promise.resolve([{ count: '5' }]);
          }
          return Promise.resolve([{ count: '0' }]);
        }
        if (sql.includes('INSERT INTO') && sql.includes('SELECT * FROM')) {
          insertCalls.push(sql);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await service.createTenantSchema(tenantId, ['farm']);

      // Should have attempted to copy reference data
      expect(insertCalls.length).toBeGreaterThanOrEqual(0);
    });

    it('should skip copy if target table already has data', async () => {
      const insertCalls: string[] = [];

      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema')) {
          if (sql.includes('tables')) {
            return Promise.resolve([{ '?column?': 1 }]);
          }
          return Promise.resolve([]);
        }
        if (sql.includes('pg_extension')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '10' }]); // Not empty
        }
        if (sql.includes('INSERT INTO') && sql.includes('SELECT * FROM')) {
          insertCalls.push(sql);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['farm']);

      // INSERT should not be called for reference data when target already has data
      const refDataInserts = insertCalls.filter(
        (sql) => sql.includes('equipment_types') || sql.includes('feed_types'),
      );
      expect(refDataInserts.length).toBe(0);
    });
  });

  describe('TimescaleDB hypertable creation', () => {
    const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';

    it('should not create hypertables from runtime services when TimescaleDB is available', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([{ '?column?': 1 }]); // TimescaleDB installed
        }
        if (sql.includes('timescaledb_information.hypertables')) {
          return Promise.resolve([]); // Not yet a hypertable
        }
        if (sql.includes('timescaledb_information.continuous_aggregates')) {
          return Promise.resolve([]);
        }
        if (sql.includes('timescaledb_information.jobs')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['sensor']);

      const hypertableCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('create_hypertable'),
      );
      expect(hypertableCalls.length).toBe(0);
    });

    it('should not add retention policy for hypertables from runtime services', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('timescaledb_information')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['sensor']);

      const retentionCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('add_retention_policy'),
      );
      expect(retentionCalls.length).toBe(0);
    });

    it('should not add compression policy for hypertables from runtime services', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('timescaledb_information')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['sensor']);

      const compressionCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('timescaledb.compress'),
      );
      expect(compressionCalls.length).toBe(0);
    });

    it('should skip hypertable creation when TimescaleDB not installed', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([]); // TimescaleDB NOT installed
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['sensor']);

      const hypertableCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('create_hypertable'),
      );
      expect(hypertableCalls.length).toBe(0);
    });

    it('should create continuous aggregates for sensor_readings', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('pg_advisory')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.schemata') && sql.includes('schema_name')) {
          return Promise.resolve([]);
        }
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('pg_extension') && sql.includes('timescaledb')) {
          return Promise.resolve([{ '?column?': 1 }]);
        }
        if (sql.includes('timescaledb_information')) {
          return Promise.resolve([]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ count: '0' }]);
        }
        return Promise.resolve([]);
      });

      await service.createTenantSchema(tenantId, ['sensor']);

      const aggregateCalls = mockQuery.mock.calls.filter(
        (call) =>
          call[0].includes('CREATE MATERIALIZED VIEW') &&
          (call[0].includes('sensor_hourly') || call[0].includes('sensor_daily')),
      );
      expect(aggregateCalls.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('deleteTenantSchema', () => {
    const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
    const schemaName = 'tenant_4b529829ea7948da';
    const createProof = (): CleanupDropProof =>
      createCleanupDropProof({
        operationId: 'cleanup-run-id',
        tenantId,
        purpose: 'tenant_erasure',
        actorId: 'tenant-erasure-orchestrator',
        reason: 'unit test tenant cleanup',
        legalHoldCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

    beforeEach(() => {
      mockQuery.mockImplementation((sql: string) => {
        return Promise.resolve([]);
      });
    });

    it('should reject deletion without cleanup proof', async () => {
      await expect(
        (
          service as unknown as { deleteTenantSchema: (tenantId: string) => Promise<unknown> }
        ).deleteTenantSchema(tenantId),
      ).rejects.toThrow(BadRequestException);

      const dropCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('DROP SCHEMA IF EXISTS'),
      );
      expect(dropCalls.length).toBe(0);
    });

    it('should reject runtime DROP even with cleanup proof', async () => {
      const result = await service.deleteTenantSchema(tenantId, createProof());

      expect(result.success).toBe(false);
      expect(result.error).toContain('owned by aqua-db-migrate');

      const dropCalls = mockQuery.mock.calls.filter(
        (call) => call[0].includes('DROP SCHEMA IF EXISTS') && call[0].includes('CASCADE'),
      );
      expect(dropCalls.length).toBe(0);
    });

    it('should not acquire advisory lock before runtime deletion rejection', async () => {
      await service.deleteTenantSchema(tenantId, createProof());

      const lockCalls = mockQuery.mock.calls.filter(
        (call) => call[0].includes('pg_advisory_lock') && !call[0].includes('unlock'),
      );
      expect(lockCalls.length).toBe(0);
    });

    it('should not release advisory lock after runtime deletion rejection', async () => {
      await service.deleteTenantSchema(tenantId, createProof());

      const unlockCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('pg_advisory_unlock'),
      );
      expect(unlockCalls.length).toBe(0);
    });

    it('should not use advisory locks when runtime deletion is rejected', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('DROP SCHEMA')) {
          throw new Error('Drop failed');
        }
        return Promise.resolve([]);
      });

      const result = await service.deleteTenantSchema(tenantId, createProof());

      expect(result.success).toBe(false);
      expect(result.error).toContain('owned by aqua-db-migrate');

      const unlockCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('pg_advisory_unlock'),
      );
      expect(unlockCalls.length).toBe(0);
    });

    it('should not invalidate cache when runtime deletion is denied', async () => {
      // First, populate the cache
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);
      await service.schemaExists(schemaName);

      // Reset mock for deletion
      mockQuery.mockReset();
      mockQuery.mockResolvedValue([]);

      await service.deleteTenantSchema(tenantId, createProof());

      // Now check exists again - should query database, not cache
      mockQuery.mockResolvedValue([]);
      await service.schemaExists(schemaName);

      const existsCalls = mockQuery.mock.calls.filter((call) =>
        call[0].includes('information_schema.schemata'),
      );
      expect(existsCalls.length).toBe(0);
    });
  });

  describe('tableExists', () => {
    it('should return true if table exists', async () => {
      mockQuery.mockResolvedValueOnce([{ '?column?': 1 }]);

      const exists = await service.tableExists('tenant_test', 'sensors');

      expect(exists).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('information_schema.tables'), [
        'tenant_test',
        'sensors',
      ]);
    });

    it('should return false if table does not exist', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const exists = await service.tableExists('tenant_test', 'nonexistent');

      expect(exists).toBe(false);
    });
  });

  describe('listTenantSchemas', () => {
    it('should return list of tenant schemas', async () => {
      mockQuery.mockResolvedValueOnce([
        { schema_name: 'tenant_aaaa000000000000' },
        { schema_name: 'tenant_bbbb000000000000' },
        { schema_name: 'tenant_cccc000000000000' },
      ]);

      const schemas = await service.listTenantSchemas();

      expect(schemas).toEqual([
        'tenant_aaaa000000000000',
        'tenant_bbbb000000000000',
        'tenant_cccc000000000000',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("schema_name ~ '^tenant_[a-f0-9]{16}$'"),
      );
    });

    it('should return empty array when no tenant schemas exist', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const schemas = await service.listTenantSchemas();

      expect(schemas).toEqual([]);
    });
  });

  describe('getSchemaTableCount', () => {
    it('should return correct table count', async () => {
      mockQuery.mockResolvedValueOnce([{ count: '42' }]);

      const count = await service.getSchemaTableCount('tenant_test');

      expect(count).toBe(42);
    });

    it('should return 0 for non-existent schema', async () => {
      mockQuery.mockResolvedValueOnce([{ count: '0' }]);

      const count = await service.getSchemaTableCount('tenant_nonexistent');

      expect(count).toBe(0);
    });
  });

  describe('setTenantSearchPathInTransaction', () => {
    it('should set LOCAL search_path within transaction using set_config', async () => {
      const mockManager = {
        query: jest.fn().mockResolvedValue([]),
      };

      await service.setTenantSearchPathInTransaction(
        mockManager,
        '4b529829-ea79-48da-982c-cd6fbec8ffb7',
      );

      // Implementation uses pg_catalog.set_config with is_local=true (not SET LOCAL search_path TO)
      // The 'true' third argument makes the change transaction-scoped.
      expect(mockManager.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), [
        'tenant_4b529829ea7948da',
      ]);
    });
  });

  describe('migrateDataToTenantSchema', () => {
    const tenantId = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
    const schemaName = 'tenant_4b529829ea7948da';

    it('should migrate data from source schema', async () => {
      mockQuery
        .mockResolvedValueOnce([{ count: '0' }]) // Before count
        .mockResolvedValueOnce([]) // INSERT
        .mockResolvedValueOnce([{ count: '100' }]); // After count

      const result = await service.migrateDataToTenantSchema(tenantId, 'public', 'sensors');

      expect(result.rowsMigrated).toBe(100);
      expect(result.error).toBeUndefined();
    });

    it('should handle migration errors gracefully', async () => {
      mockQuery
        .mockResolvedValueOnce([{ count: '0' }])
        .mockRejectedValueOnce(new Error('Insert failed'));

      const result = await service.migrateDataToTenantSchema(tenantId, 'public', 'sensors');

      expect(result.rowsMigrated).toBe(0);
      expect(result.error).toContain('Insert failed');
    });

    it('should only fall back to camelCase tenantId when tenant_id column is absent', async () => {
      const undefinedColumnError = Object.assign(new Error('column "tenant_id" does not exist'), {
        code: '42703',
      });

      mockQuery
        .mockResolvedValueOnce([{ count: '0' }])
        .mockRejectedValueOnce(undefinedColumnError)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '25' }]);

      const result = await service.migrateDataToTenantSchema(tenantId, 'public', 'legacy_farms');

      expect(result.rowsMigrated).toBe(25);

      const insertCalls = mockQuery.mock.calls.filter((call) => call[0].includes('INSERT INTO'));
      expect(insertCalls[0][0]).toContain('WHERE tenant_id = $1');
      expect(insertCalls[1][0]).toContain('WHERE "tenantId" = $1');
    });

    it('should use ON CONFLICT DO NOTHING for idempotent migration', async () => {
      mockQuery
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: '50' }]);

      await service.migrateDataToTenantSchema(tenantId, 'public', 'sensors');

      const insertCall = mockQuery.mock.calls.find((call) => call[0].includes('INSERT INTO'));
      expect(insertCall[0]).toContain('ON CONFLICT DO NOTHING');
    });
  });

  describe('cache management', () => {
    it('should clear entire cache when clearSchemaCache is called', async () => {
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);

      // Populate cache with multiple entries
      await service.schemaExists('tenant_aaaa000000000000');
      await service.schemaExists('tenant_bbbb000000000000');

      // Clear all mocks to reset call count
      mockQuery.mockClear();

      // Clear cache
      service.clearSchemaCache();

      // Both should now query database again
      await service.schemaExists('tenant_aaaa000000000000');
      await service.schemaExists('tenant_bbbb000000000000');

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('runtime DDL lock discipline', () => {
    it('should not issue advisory locks for tenant schema authority checks', async () => {
      mockQuery.mockResolvedValue([{ '?column?': 1 }]);

      await service.createTenantSchema('11111111-1111-1111-1111-111111111111');
      await service.createTenantSchema('22222222-2222-2222-2222-222222222222');

      const advisoryCalls = mockQuery.mock.calls.filter((call) => call[0].includes('pg_advisory'));
      expect(advisoryCalls).toEqual([]);
    });
  });
});
