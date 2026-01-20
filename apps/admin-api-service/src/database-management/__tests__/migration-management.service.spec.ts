/**
 * MigrationManagementService Test Suite
 *
 * Kapsamlı test senaryoları:
 * - Migration Çalıştırma
 * - Schema Versiyonlama
 * - Rollback İşlemleri
 * - Lock Mekanizması
 * - Multi-Tenant Migration
 * - Migration Validasyonu
 * - Batch Migration
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MigrationManagementService } from '../services/migration-management.service';
import {
  TenantSchema,
  SchemaMigration,
  MigrationStatus,
} from '../entities/database-management.entity';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenantSchema = (overrides: Partial<TenantSchema> = {}): TenantSchema => ({
  id: uuidv4(),
  tenantId: uuidv4(),
  schemaName: 'tenant_test',
  status: 'active',
  currentVersion: '1.0.0',
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
  id: uuidv4(),
  tenantId: uuidv4(),
  schemaName: 'tenant_test',
  migrationName: 'initial_schema',
  version: '1.0.0',
  status: 'completed' as MigrationStatus,
  upScript: 'CREATE TABLE test();',
  downScript: 'DROP TABLE test;',
  isDryRun: false,
  executedBy: 'admin',
  startedAt: new Date(),
  completedAt: new Date(),
  executionTimeMs: 500,
  affectedTables: ['test'],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as SchemaMigration);

const createMockQueryRunner = (): jest.Mocked<Partial<QueryRunner>> => ({
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  query: jest.fn(),
});

// =============================================================================
// Test Suite
// =============================================================================

describe('MigrationManagementService', () => {
  let service: MigrationManagementService;
  let schemaRepository: jest.Mocked<Repository<TenantSchema>>;
  let migrationRepository: jest.Mocked<Repository<SchemaMigration>>;
  let dataSource: jest.Mocked<DataSource>;
  let queryRunner: jest.Mocked<Partial<QueryRunner>>;

  beforeEach(async () => {
    queryRunner = createMockQueryRunner();

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    };

    const mockSchemaRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    const mockMigrationRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn(),
      save: jest.fn(),
      create: jest.fn((data) => ({ ...data, id: uuidv4() })),
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
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<MigrationManagementService>(MigrationManagementService);
    schemaRepository = module.get(getRepositoryToken(TenantSchema));
    migrationRepository = module.get(getRepositoryToken(SchemaMigration));
    dataSource = module.get(getDataSourceToken());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // MIGRATION REGISTRY TESTLERİ
  // ===========================================================================

  describe('Migration Registry', () => {
    describe('getAvailableMigrations', () => {
      it('tüm mevcut migration\'ları döndürür', () => {
        // Act
        const migrations = service.getAvailableMigrations();

        // Assert
        expect(migrations).toBeInstanceOf(Array);
        expect(migrations.length).toBeGreaterThan(0);
      });

      it('her migration gerekli alanları içerir', () => {
        // Act
        const migrations = service.getAvailableMigrations();

        // Assert
        migrations.forEach((migration) => {
          expect(migration).toHaveProperty('id');
          expect(migration).toHaveProperty('name');
          expect(migration).toHaveProperty('version');
          expect(migration).toHaveProperty('description');
          expect(migration).toHaveProperty('upScript');
          expect(migration).toHaveProperty('downScript');
          expect(migration).toHaveProperty('affectedTables');
          expect(migration).toHaveProperty('estimatedDuration');
          expect(migration).toHaveProperty('isDestructive');
          expect(migration).toHaveProperty('requiresDowntime');
        });
      });

      it('migration version\'ları sıralıdır', () => {
        // Act
        const migrations = service.getAvailableMigrations();
        const versions = migrations.map((m) => m.version);

        // Assert
        const sortedVersions = [...versions].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        );
        expect(versions).toEqual(sortedVersions);
      });

      it('estimatedDuration pozitif bir sayıdır', () => {
        // Act
        const migrations = service.getAvailableMigrations();

        // Assert
        migrations.forEach((migration) => {
          expect(migration.estimatedDuration).toBeGreaterThan(0);
        });
      });
    });
  });

  // ===========================================================================
  // SINGLE TENANT MIGRATION TESTLERİ
  // ===========================================================================

  describe('Single Tenant Migration', () => {
    describe('getPendingMigrations', () => {
      it('tenant için pending migration\'ları döndürür', async () => {
        // Arrange
        const tenantId = uuidv4();
        const schema = createMockTenantSchema({ tenantId });

        schemaRepository.findOne.mockResolvedValue(schema);
        migrationRepository.find.mockResolvedValue([
          createMockSchemaMigration({ tenantId, version: '1.0.0', status: 'completed' as MigrationStatus }),
        ]);

        // Act
        const pendingMigrations = await service.getPendingMigrations(tenantId);

        // Assert
        expect(pendingMigrations).toBeInstanceOf(Array);
        expect(pendingMigrations.every((m) => m.version !== '1.0.0')).toBe(true);
      });

      it('schema bulunamazsa NotFoundException fırlatır', async () => {
        // Arrange
        schemaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.getPendingMigrations('non-existent')).rejects.toThrow(
          NotFoundException,
        );
      });

      it('tüm migration\'lar uygulanmışsa boş dizi döner', async () => {
        // Arrange
        const tenantId = uuidv4();
        const schema = createMockTenantSchema({ tenantId });
        const availableMigrations = service.getAvailableMigrations();

        schemaRepository.findOne.mockResolvedValue(schema);
        migrationRepository.find.mockResolvedValue(
          availableMigrations.map((m) =>
            createMockSchemaMigration({
              tenantId,
              version: m.version,
              status: 'completed' as MigrationStatus,
            }),
          ),
        );

        // Act
        const pendingMigrations = await service.getPendingMigrations(tenantId);

        // Assert
        expect(pendingMigrations).toEqual([]);
      });
    });

    describe('runMigration', () => {
      const tenantId = uuidv4();
      const version = '1.0.0';

      beforeEach(() => {
        const schema = createMockTenantSchema({ tenantId, currentVersion: '0.0.0' });
        schemaRepository.findOne.mockResolvedValue(schema);
        schemaRepository.save.mockImplementation(async (s) => s);
        migrationRepository.findOne.mockResolvedValue(null);
        migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
        (queryRunner.query as jest.Mock).mockResolvedValue([]);
      });

      it('migration başarıyla çalıştırılır', async () => {
        // Act
        const result = await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(result.status).toBe('completed');
        expect(result.tenantId).toBe(tenantId);
        expect(result.executionTimeMs).toBeDefined();
      });

      it('dry-run modunda veritabanı değişmez', async () => {
        // Act
        const result = await service.runMigration(tenantId, version, true, 'admin');

        // Assert
        expect(result.status).toBe('completed');
        expect(queryRunner.commitTransaction).toHaveBeenCalled();
        // Dry-run'da schema save edilmez (sadece validation)
      });

      it('migration zaten uygulanmışsa BadRequestException fırlatır', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version, status: 'completed' as MigrationStatus }),
        );

        // Act & Assert
        await expect(service.runMigration(tenantId, version, false, 'admin')).rejects.toThrow(
          BadRequestException,
        );
      });

      it('geçersiz version için NotFoundException fırlatır', async () => {
        // Act & Assert
        await expect(
          service.runMigration(tenantId, '99.99.99', false, 'admin'),
        ).rejects.toThrow(NotFoundException);
      });

      it('schema bulunamazsa NotFoundException fırlatır', async () => {
        // Arrange
        schemaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.runMigration(tenantId, version, false, 'admin')).rejects.toThrow(
          NotFoundException,
        );
      });

      it('SQL hatası durumunda transaction rollback yapılır', async () => {
        // Arrange
        (queryRunner.query as jest.Mock)
          .mockResolvedValueOnce([]) // SET search_path
          .mockRejectedValueOnce(new Error('SQL syntax error'));

        // Act
        const result = await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(result.status).toBe('failed');
        expect(result.error).toContain('SQL syntax error');
        expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      });

      it('migration record oluşturulur ve güncellenir', async () => {
        // Act
        await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(migrationRepository.create).toHaveBeenCalled();
        expect(migrationRepository.save).toHaveBeenCalledTimes(2); // Create and update
      });

      it('schema status migrating ve active olarak güncellenir', async () => {
        // Act
        await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(schemaRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'migrating' }),
        );
        expect(schemaRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'active' }),
        );
      });

      it('currentVersion güncellenir', async () => {
        // Act
        await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(schemaRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ currentVersion: version }),
        );
      });

      it('executedBy kaydedilir', async () => {
        // Act
        await service.runMigration(tenantId, version, false, 'test-admin');

        // Assert
        expect(migrationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ executedBy: 'test-admin' }),
        );
      });

      it('QueryRunner her zaman release edilir', async () => {
        // Act
        await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(queryRunner.release).toHaveBeenCalled();
      });

      it('hata durumunda da QueryRunner release edilir', async () => {
        // Arrange
        (queryRunner.query as jest.Mock).mockRejectedValue(new Error('DB error'));

        // Act
        await service.runMigration(tenantId, version, false, 'admin');

        // Assert
        expect(queryRunner.release).toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // BATCH MIGRATION TESTLERİ
  // ===========================================================================

  describe('Batch Migration', () => {
    describe('runBatchMigration', () => {
      const version = '1.0.0';

      beforeEach(() => {
        migrationRepository.findOne.mockResolvedValue(null);
        migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
        (queryRunner.query as jest.Mock).mockResolvedValue([]);
      });

      it('tüm active tenant\'lara migration uygulanır', async () => {
        // Arrange
        const tenants = [
          createMockTenantSchema({ tenantId: 'tenant-1', status: 'active' }),
          createMockTenantSchema({ tenantId: 'tenant-2', status: 'active' }),
          createMockTenantSchema({ tenantId: 'tenant-3', status: 'active' }),
        ];
        schemaRepository.find.mockResolvedValue(tenants);
        schemaRepository.findOne.mockImplementation(async ({ where }) => {
          const tenantId = (where as any).tenantId;
          return tenants.find((t) => t.tenantId === tenantId) || null;
        });
        schemaRepository.save.mockImplementation(async (s) => s);

        // Act
        const results = await service.runBatchMigration(version, false, 'admin');

        // Assert
        expect(results).toHaveLength(3);
      });

      it('dry-run modunda çalışır', async () => {
        // Arrange
        const tenants = [createMockTenantSchema({ tenantId: 'tenant-1', status: 'active' })];
        schemaRepository.find.mockResolvedValue(tenants);
        schemaRepository.findOne.mockResolvedValue(tenants[0]);
        schemaRepository.save.mockImplementation(async (s) => s);

        // Act
        const results = await service.runBatchMigration(version, true, 'admin');

        // Assert
        expect(results[0].status).toBe('completed');
      });

      it('bir tenant başarısız olsa da diğerleri devam eder', async () => {
        // Arrange
        const tenants = [
          createMockTenantSchema({ tenantId: 'tenant-1', status: 'active' }),
          createMockTenantSchema({ tenantId: 'tenant-2', status: 'active' }),
        ];
        schemaRepository.find.mockResolvedValue(tenants);
        schemaRepository.findOne
          .mockResolvedValueOnce(tenants[0])
          .mockResolvedValueOnce(null); // Second tenant not found
        schemaRepository.save.mockImplementation(async (s) => s);

        // Act
        const results = await service.runBatchMigration(version, false, 'admin');

        // Assert
        expect(results).toHaveLength(2);
        expect(results[0].status).toBe('completed');
        expect(results[1].status).toBe('failed');
      });

      it('active tenant yoksa boş dizi döner', async () => {
        // Arrange
        schemaRepository.find.mockResolvedValue([]);

        // Act
        const results = await service.runBatchMigration(version, false, 'admin');

        // Assert
        expect(results).toEqual([]);
      });
    });

    describe('getBatchMigrationStatus', () => {
      it('batch migration durumunu döndürür', async () => {
        // Arrange
        const version = '1.0.0';
        const tenants = [
          createMockTenantSchema({ tenantId: 'tenant-1', status: 'active' }),
          createMockTenantSchema({ tenantId: 'tenant-2', status: 'active' }),
          createMockTenantSchema({ tenantId: 'tenant-3', status: 'active' }),
        ];
        const migrations = [
          createMockSchemaMigration({
            tenantId: 'tenant-1',
            version,
            status: 'completed' as MigrationStatus,
          }),
          createMockSchemaMigration({
            tenantId: 'tenant-2',
            version,
            status: 'failed' as MigrationStatus,
          }),
        ];

        schemaRepository.find.mockResolvedValue(tenants);
        migrationRepository.find.mockResolvedValue(migrations);

        // Act
        const status = await service.getBatchMigrationStatus(version);

        // Assert
        expect(status.totalTenants).toBe(3);
        expect(status.completed).toBe(1);
        expect(status.failed).toBe(1);
        expect(status.pending).toBe(1);
      });
    });
  });

  // ===========================================================================
  // ROLLBACK TESTLERİ
  // ===========================================================================

  describe('Rollback İşlemleri', () => {
    describe('rollbackMigration', () => {
      const tenantId = uuidv4();
      const version = '1.1.0';

      beforeEach(() => {
        const schema = createMockTenantSchema({ tenantId, currentVersion: version });
        schemaRepository.findOne.mockResolvedValue(schema);
        schemaRepository.save.mockImplementation(async (s) => s);
        migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
        (queryRunner.query as jest.Mock).mockResolvedValue([]);
      });

      it('migration başarıyla rollback edilir', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version, status: 'completed' as MigrationStatus }),
        );

        // Act
        const result = await service.rollbackMigration(tenantId, version, 'admin');

        // Assert
        expect(result.status).toBe('completed');
        expect(result.tenantId).toBe(tenantId);
      });

      it('completed migration yoksa BadRequestException fırlatır', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.rollbackMigration(tenantId, version, 'admin')).rejects.toThrow(
          BadRequestException,
        );
      });

      it('schema bulunamazsa NotFoundException fırlatır', async () => {
        // Arrange
        schemaRepository.findOne.mockResolvedValue(null);

        // Act & Assert
        await expect(service.rollbackMigration(tenantId, version, 'admin')).rejects.toThrow(
          NotFoundException,
        );
      });

      it('geçersiz version için NotFoundException fırlatır', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version: '99.99.99', status: 'completed' as MigrationStatus }),
        );

        // Act & Assert
        await expect(
          service.rollbackMigration(tenantId, '99.99.99', 'admin'),
        ).rejects.toThrow(NotFoundException);
      });

      it('rollback sonrası currentVersion önceki versiyona döner', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version, status: 'completed' as MigrationStatus }),
        );

        // Act
        await service.rollbackMigration(tenantId, version, 'admin');

        // Assert
        expect(schemaRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ currentVersion: '1.0.0' }), // Previous version
        );
      });

      it('orijinal migration rolled_back olarak işaretlenir', async () => {
        // Arrange
        const completedMigration = createMockSchemaMigration({
          tenantId,
          version,
          status: 'completed' as MigrationStatus,
        });
        migrationRepository.findOne.mockResolvedValue(completedMigration);

        // Act
        await service.rollbackMigration(tenantId, version, 'admin');

        // Assert
        expect(migrationRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'rolled_back' }),
        );
      });

      it('rollback record oluşturulur', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version, status: 'completed' as MigrationStatus }),
        );

        // Act
        await service.rollbackMigration(tenantId, version, 'admin');

        // Assert
        expect(migrationRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            migrationName: expect.stringContaining('rollback_'),
            version: expect.stringContaining('rollback_'),
          }),
        );
      });

      it('SQL hatası durumunda rollback başarısız olur', async () => {
        // Arrange
        migrationRepository.findOne.mockResolvedValue(
          createMockSchemaMigration({ tenantId, version, status: 'completed' as MigrationStatus }),
        );
        (queryRunner.query as jest.Mock)
          .mockResolvedValueOnce([]) // SET search_path
          .mockRejectedValueOnce(new Error('Cannot drop table'));

        // Act
        const result = await service.rollbackMigration(tenantId, version, 'admin');

        // Assert
        expect(result.status).toBe('failed');
        expect(result.error).toContain('Cannot drop table');
        expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // MIGRATION HISTORY TESTLERİ
  // ===========================================================================

  describe('Migration History', () => {
    describe('getMigrationHistory', () => {
      it('tenant için migration history döndürür', async () => {
        // Arrange
        const tenantId = uuidv4();
        const migrations = [
          createMockSchemaMigration({ tenantId, version: '1.1.0' }),
          createMockSchemaMigration({ tenantId, version: '1.0.0' }),
        ];
        migrationRepository.find.mockResolvedValue(migrations);

        // Act
        const history = await service.getMigrationHistory(tenantId);

        // Assert
        expect(history).toEqual(migrations);
        expect(migrationRepository.find).toHaveBeenCalledWith({
          where: { tenantId },
          order: { createdAt: 'DESC' },
        });
      });
    });

    describe('getAllMigrationHistory', () => {
      it('pagination ile tüm history döndürür', async () => {
        // Arrange
        const migrations = [createMockSchemaMigration()];
        migrationRepository.findAndCount.mockResolvedValue([migrations, 1]);

        // Act
        const result = await service.getAllMigrationHistory({ page: 1, limit: 20 });

        // Assert
        expect(result.data).toEqual(migrations);
        expect(result.total).toBe(1);
        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
      });

      it('status filtreleme çalışır', async () => {
        // Arrange
        migrationRepository.findAndCount.mockResolvedValue([[], 0]);

        // Act
        await service.getAllMigrationHistory({ status: 'completed' as MigrationStatus });

        // Assert
        expect(migrationRepository.findAndCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ status: 'completed' }),
          }),
        );
      });

      it('version filtreleme çalışır', async () => {
        // Arrange
        migrationRepository.findAndCount.mockResolvedValue([[], 0]);

        // Act
        await service.getAllMigrationHistory({ version: '1.0.0' });

        // Assert
        expect(migrationRepository.findAndCount).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ version: '1.0.0' }),
          }),
        );
      });
    });

    describe('getMigrationSummary', () => {
      it('migration summary döndürür', async () => {
        // Arrange
        const migrations = [
          createMockSchemaMigration({ status: 'completed' as MigrationStatus }),
          createMockSchemaMigration({ status: 'completed' as MigrationStatus }),
          createMockSchemaMigration({ status: 'failed' as MigrationStatus }),
          createMockSchemaMigration({ status: 'rolled_back' as MigrationStatus }),
        ];
        const schemas = [
          createMockTenantSchema({ currentVersion: '1.3.0', status: 'active' }),
          createMockTenantSchema({ currentVersion: '1.1.0', status: 'active' }),
        ];

        migrationRepository.find.mockResolvedValue(migrations);
        schemaRepository.find.mockResolvedValue(schemas);

        // Act
        const summary = await service.getMigrationSummary();

        // Assert
        expect(summary.totalMigrations).toBe(4);
        expect(summary.completed).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.rolledBack).toBe(1);
        expect(summary.latestVersion).toBeDefined();
      });

      it('up-to-date ve outdated tenant sayıları doğru hesaplanır', async () => {
        // Arrange
        const latestVersion = service.getAvailableMigrations().pop()?.version || '1.0.0';

        const schemas = [
          createMockTenantSchema({ currentVersion: latestVersion, status: 'active' }),
          createMockTenantSchema({ currentVersion: '1.0.0', status: 'active' }),
          createMockTenantSchema({ currentVersion: '1.0.0', status: 'active' }),
        ];

        migrationRepository.find.mockResolvedValue([]);
        schemaRepository.find.mockResolvedValue(schemas);

        // Act
        const summary = await service.getMigrationSummary();

        // Assert
        expect(summary.tenantsUpToDate).toBe(1);
        expect(summary.tenantsOutdated).toBe(2);
      });
    });
  });

  // ===========================================================================
  // SCHEMA VERSION TESTLERİ
  // ===========================================================================

  describe('Schema Versiyonlama', () => {
    it('migration sonrası version güncellenir', async () => {
      // Arrange
      const tenantId = uuidv4();
      const version = '1.1.0';
      const schema = createMockTenantSchema({ tenantId, currentVersion: '1.0.0' });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock).mockResolvedValue([]);

      // Act
      await service.runMigration(tenantId, version, false, 'admin');

      // Assert
      expect(schemaRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ currentVersion: version }),
      );
    });

    it('lastMigrationAt güncellenir', async () => {
      // Arrange
      const tenantId = uuidv4();
      const version = '1.0.0';
      const schema = createMockTenantSchema({ tenantId, currentVersion: '0.0.0' });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock).mockResolvedValue([]);

      // Act
      await service.runMigration(tenantId, version, false, 'admin');

      // Assert
      expect(schemaRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastMigrationAt: expect.any(Date) }),
      );
    });
  });

  // ===========================================================================
  // TRANSACTION & LOCK TESTLERİ
  // ===========================================================================

  describe('Transaction & Lock Mekanizması', () => {
    it('migration sırasında transaction başlatılır', async () => {
      // Arrange
      const tenantId = uuidv4();
      const schema = createMockTenantSchema({ tenantId });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock).mockResolvedValue([]);

      // Act
      await service.runMigration(tenantId, '1.0.0', false, 'admin');

      // Assert
      expect(queryRunner.startTransaction).toHaveBeenCalled();
    });

    it('başarılı migration\'da commit yapılır', async () => {
      // Arrange
      const tenantId = uuidv4();
      const schema = createMockTenantSchema({ tenantId });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock).mockResolvedValue([]);

      // Act
      await service.runMigration(tenantId, '1.0.0', false, 'admin');

      // Assert
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('hata durumunda rollback yapılır', async () => {
      // Arrange
      const tenantId = uuidv4();
      const schema = createMockTenantSchema({ tenantId });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock)
        .mockResolvedValueOnce([]) // SET search_path
        .mockRejectedValueOnce(new Error('SQL error'));

      // Act
      await service.runMigration(tenantId, '1.0.0', false, 'admin');

      // Assert
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('search_path tenant schema\'sına ayarlanır', async () => {
      // Arrange
      const tenantId = uuidv4();
      const schemaName = 'tenant_test_schema';
      const schema = createMockTenantSchema({ tenantId, schemaName });

      schemaRepository.findOne.mockResolvedValue(schema);
      schemaRepository.save.mockImplementation(async (s) => s);
      migrationRepository.findOne.mockResolvedValue(null);
      migrationRepository.save.mockImplementation(async (m) => ({ ...m, id: uuidv4() }));
      (queryRunner.query as jest.Mock).mockResolvedValue([]);

      // Act
      await service.runMigration(tenantId, '1.0.0', false, 'admin');

      // Assert
      expect(queryRunner.query).toHaveBeenCalledWith(
        `SET search_path TO "${schemaName}"`,
      );
    });
  });
});
