import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import {
  MigrationStatus,
  SchemaMigration,
  TenantSchema,
} from '../entities/database-management.entity';
import { MigrationManagementService } from '../services/migration-management.service';

const createMockTenantSchema = (
  overrides: Partial<TenantSchema> = {},
): TenantSchema => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  schemaName: 'tenant_test',
  status: 'active',
  currentVersion: '0.0.0',
  tableCount: 5,
  sizeBytes: 1024000,
  lastMigrationAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as TenantSchema);

const createMockSchemaMigration = (
  overrides: Partial<SchemaMigration> = {},
): SchemaMigration => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  schemaName: 'tenant_test',
  migrationName: 'db_migrate_owned',
  version: '0.0.0',
  status: 'completed' as MigrationStatus,
  upScript: '',
  downScript: '',
  isDryRun: false,
  executedBy: 'db-migrate',
  startedAt: new Date(),
  completedAt: new Date(),
  executionTimeMs: 500,
  affectedTables: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as SchemaMigration);

describe('MigrationManagementService authority boundary', () => {
  let service: MigrationManagementService;
  let schemaRepository: jest.Mocked<Repository<TenantSchema>>;
  let migrationRepository: jest.Mocked<Repository<SchemaMigration>>;

  beforeEach(async () => {
    const mockSchemaRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const mockMigrationRepository = {
      find: jest.fn(),
      findAndCount: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationManagementService,
        {
          provide: getRepositoryToken(TenantSchema),
          useValue: mockSchemaRepository,
        },
        {
          provide: getRepositoryToken(SchemaMigration),
          useValue: mockMigrationRepository,
        },
      ],
    }).compile();

    service = module.get<MigrationManagementService>(MigrationManagementService);
    schemaRepository = module.get(getRepositoryToken(TenantSchema));
    migrationRepository = module.get(getRepositoryToken(SchemaMigration));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not expose runtime migration definitions from admin-api', () => {
    expect(service.getAvailableMigrations()).toEqual([]);
  });

  it('returns no pending runtime migrations for a known tenant', async () => {
    const tenantId = randomUUID();
    schemaRepository.findOne.mockResolvedValue(createMockTenantSchema({ tenantId }));
    migrationRepository.find.mockResolvedValue([
      createMockSchemaMigration({ tenantId }),
    ]);

    await expect(service.getPendingMigrations(tenantId)).resolves.toEqual([]);
  });

  it('fails pending migration lookup for an unknown tenant', async () => {
    schemaRepository.findOne.mockResolvedValue(null);

    await expect(service.getPendingMigrations(randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('fails closed for single-tenant runtime migration execution', async () => {
    await expect(
      service.runMigration(randomUUID(), '1.0.0', false, 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(schemaRepository.findOne).not.toHaveBeenCalled();
  });

  it('fails closed for batch runtime migration execution', async () => {
    await expect(
      service.runBatchMigration('1.0.0', false, 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(schemaRepository.find).not.toHaveBeenCalled();
  });

  it('fails closed for runtime rollback execution', async () => {
    await expect(
      service.rollbackMigration(randomUUID(), '1.0.0', 'admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(migrationRepository.find).not.toHaveBeenCalled();
  });

  it('keeps batch migration status read-only', async () => {
    const tenantId = randomUUID();
    schemaRepository.find.mockResolvedValue([
      createMockTenantSchema({ tenantId }),
    ]);
    migrationRepository.find.mockResolvedValue([
      createMockSchemaMigration({ tenantId, version: '0.0.0' }),
    ]);

    await expect(service.getBatchMigrationStatus('0.0.0')).resolves.toMatchObject({
      totalTenants: 1,
      completed: 1,
      pending: 0,
      failed: 0,
      tenants: [{ tenantId, status: 'completed' }],
    });
  });

  it('summarizes db-migrate-owned history without declaring latest runtime version', async () => {
    schemaRepository.find.mockResolvedValue([
      createMockTenantSchema({ currentVersion: '0.0.0' }),
    ]);
    migrationRepository.find.mockResolvedValue([
      createMockSchemaMigration({ status: 'completed' }),
      createMockSchemaMigration({ status: 'failed' }),
    ]);

    await expect(service.getMigrationSummary()).resolves.toMatchObject({
      totalMigrations: 2,
      completed: 1,
      failed: 1,
      latestVersion: '0.0.0',
      tenantsUpToDate: 1,
      tenantsOutdated: 0,
    });
  });
});
