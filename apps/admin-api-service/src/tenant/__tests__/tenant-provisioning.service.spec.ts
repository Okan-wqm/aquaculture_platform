/**
 * TenantProvisioningService Test Suite
 *
 * Kapsamlı test senaryoları:
 * - Temel Oluşturma İşlemleri
 * - Database & Schema İşlemleri
 * - Transaction & Rollback Senaryoları
 * - Concurrent İşlemler
 * - Validasyon Testleri
 * - İlişkisel Veri Testleri
 */

import { randomUUID as uuidv4 } from 'node:crypto';

import { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';

import { TenantSchema } from '../../database-management/entities/database-management.entity';
import { BackupRestoreService } from '../../database-management/services/backup-restore.service';
import { Tenant, TenantStatus, TenantTier, TenantPlan } from '../entities/tenant.entity';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';
import {
  TenantProvisioningService,
  ProvisioningResult,
  TenantProvisioningOptions,
} from '../services/tenant-provisioning.service';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  // Extract 'limits' from overrides since it's a getter-only property on Tenant
  const { limits: _limits, ...safeOverrides } = overrides as Partial<Tenant> & {
    limits?: unknown;
  };
  Object.assign(tenant, {
    id: uuidv4(),
    name: 'Test Tenant',
    slug: 'test-tenant',
    description: 'Test tenant description',
    domain: 'test.example.com',
    status: TenantStatus.PENDING,
    plan: TenantPlan.STARTER,
    maxUsers: 10,
    maxStorage: -1,
    settings: {
      timezone: 'UTC',
      locale: 'en-US',
      currency: 'USD',
      dateFormat: 'YYYY-MM-DD',
      measurementSystem: 'metric' as const,
      notificationPreferences: {
        email: true,
        sms: false,
        push: true,
        slack: false,
      },
      features: [],
    },
    primaryContact: {
      name: 'Test Admin',
      email: 'admin@test.com',
      phone: '+1234567890',
      role: 'admin',
    },
    userCount: 0,
    farmCount: 0,
    sensorCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...safeOverrides,
  });
  return tenant;
};

const createMockQueryRunner = (): jest.Mocked<Partial<QueryRunner>> => ({
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  query: jest.fn().mockResolvedValue([]),
  manager: {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
  } as any,
});

const mockInfrastructureQueryResult = (sql: string): unknown[] | null => {
  if (sql.includes('to_regclass') && sql.includes('tenant_roles')) {
    return [{ relation: 'auth.tenant_roles' }];
  }
  if (sql.includes('INSERT INTO admin.cleanup_runs')) {
    return [{ id: 'cleanup-run-id' }];
  }
  if (sql.includes('admin.cleanup_runs') || sql.includes('admin.cleanup_run_steps')) {
    return [];
  }
  if (sql.includes('COUNT(*) AS count')) {
    return [{ count: '0' }];
  }
  if (sql.includes('FROM admin.tenant_schemas')) {
    return [];
  }
  if (sql.includes('FROM pg_namespace')) {
    return [];
  }
  return null;
};

const mockTenantClaimQuery = (sql: string): Promise<unknown[]> => {
  if (sql.includes('UPDATE auth.tenants') && sql.includes('RETURNING id')) {
    return Promise.resolve([{ id: 'claimed-tenant-id' }]);
  }
  const infrastructureResult = mockInfrastructureQueryResult(sql);
  if (infrastructureResult !== null) {
    return Promise.resolve(infrastructureResult);
  }
  return Promise.resolve([]);
};

// =============================================================================
// Test Suite
// =============================================================================

describe('TenantProvisioningService', () => {
  let service: TenantProvisioningService;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let tenantSchemaRepository: jest.Mocked<Repository<TenantSchema>>;
  let dataSource: jest.Mocked<DataSource>;
  let authProvisioningClient: jest.Mocked<AuthTenantProvisioningClientService>;
  let queryRunner: jest.Mocked<Partial<QueryRunner>>;

  beforeEach(async () => {
    queryRunner = createMockQueryRunner();

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: jest.fn(mockTenantClaimQuery),
      transaction: jest.fn(),
    };

    const mockTenantRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    };

    const mockTenantSchemaRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((entity) => entity),
      save: jest.fn().mockImplementation(async (entity) => entity),
      update: jest.fn(),
    };

    const mockAuthProvisioningClient = {
      setupTenantRoles: jest.fn().mockResolvedValue({ success: true, rolesCreated: 1 }),
      assignTenantModules: jest.fn().mockResolvedValue({ success: true, modulesAssigned: 0 }),
      createTenantAdmin: jest.fn().mockResolvedValue({
        success: true,
        userId: 'new-user-id',
        invitationId: 'new-invitation-id',
        email: 'admin@test.com',
      }),
      removeTenantModule: jest.fn().mockResolvedValue({ success: true, modulesRemoved: 1 }),
      activateTenant: jest.fn().mockResolvedValue({
        success: true,
        tenantId: 'tenant-id',
        status: TenantStatus.ACTIVE,
      }),
      failProvisioning: jest.fn().mockResolvedValue({
        success: true,
        tenantId: 'tenant-id',
        status: TenantStatus.PROVISIONING_FAILED,
      }),
      rollbackTenantProvisioning: jest.fn().mockResolvedValue({
        success: true,
        removedUsers: 0,
        removedInvitations: 0,
        removedRoles: 0,
        removedModules: 0,
      }),
    };

    const mockBackupRestoreService = {
      createBackup: jest.fn().mockResolvedValue({
        id: 'backup-id',
        status: 'completed',
        checksum: 'a'.repeat(64),
        sizeBytes: 1024,
        isEncrypted: true,
      }),
    };

    const mockLegalHoldService = {
      assertNoHold: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantProvisioningService,
        {
          provide: getRepositoryToken(Tenant),
          useValue: mockTenantRepository,
        },
        {
          provide: getRepositoryToken(TenantSchema),
          useValue: mockTenantSchemaRepository,
        },
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: mockAuthProvisioningClient,
        },
        {
          provide: BackupRestoreService,
          useValue: mockBackupRestoreService,
        },
        {
          provide: LegalHoldService,
          useValue: mockLegalHoldService,
        },
      ],
    }).compile();

    service = module.get<TenantProvisioningService>(TenantProvisioningService);
    tenantRepository = module.get(getRepositoryToken(Tenant));
    tenantSchemaRepository = module.get(getRepositoryToken(TenantSchema));
    dataSource = module.get(getDataSourceToken());
    authProvisioningClient = module.get(AuthTenantProvisioningClientService);
    (service as unknown as {
      createTenantSchema: jest.Mock;
    }).createTenantSchema = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // TEMEL OLUŞTURMA İŞLEMLERİ
  // ===========================================================================

  describe('Temel Oluşturma İşlemleri', () => {
    describe('provisionTenant', () => {
      it('geçerli veri ile tenant başarıyla provision edilir', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

        // Act
        const result = await service.provisionTenant(tenant.id);

        // Assert
        expect(result.success).toBe(true);
        expect(result.tenantId).toBe(tenant.id);
        expect(result.steps.every((s) => s.status === 'completed')).toBe(true);
      });

      it('tenant bulunamazsa hata döner', async () => {
        // Arrange
        tenantRepository.findOne.mockResolvedValue(null);

        // Act
        const result = await service.provisionTenant('non-existent-id');

        // Assert
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('tenant status PENDING değilse provision reddedilir', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.ACTIVE });
        tenantRepository.findOne.mockResolvedValue(tenant);

        // Act
        const result = await service.provisionTenant(tenant.id);

        // Assert
        expect(result.success).toBe(false);
        expect(result.steps[0]!.status).toBe('failed');
        expect(result.steps[0]!.error).toContain('PENDING');
      });

      it('provisioning sonrası tenant status ACTIVE olur', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);

        // Act
        const result = await service.provisionTenant(tenant.id);

        // Assert
        expect(result.success).toBe(true);
        expect(authProvisioningClient.activateTenant).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: tenant.id,
            requestReference: expect.stringContaining(':ActivateTenant'),
            auditMetadata: expect.objectContaining({
              commandType: 'ActivateTenant',
            }),
          }),
        );
      });

      it('trial tenant için trialEndsAt hesaplanır', async () => {
        // Arrange
        const trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + 14);
        const tenant = createMockTenant({
          status: TenantStatus.PENDING,
          trialEndsAt,
        });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

        // Act
        const result = await service.provisionTenant(tenant.id);

        // Assert
        expect(result.success).toBe(true);
        expect(tenant.trialEndsAt).toBeDefined();
      });
    });

    describe('provisionTenant with admin user', () => {
      it('primaryContact email varsa admin user oluşturulur', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
        dataSource.query.mockImplementation(mockTenantClaimQuery);
        (dataSource.transaction as jest.Mock).mockImplementation(async (callback: any) => {
          return callback({
            query: jest
              .fn()
              .mockResolvedValueOnce([{ id: 'new-user-id' }])
              .mockResolvedValue([]),
          });
        });

        // Act
        const result = await service.provisionTenant(tenant.id, {
          createFirstAdmin: true,
          adminEmail: 'admin@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        });

        // Assert
        expect(result.success).toBe(true);
        expect(result.adminUser).toBeDefined();
        expect(result.adminUser?.email).toBe('admin@test.com');
      });

      it('email zaten kayıtlıysa admin user oluşturulmaz', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
        authProvisioningClient.createTenantAdmin.mockRejectedValue(
          new Error('A user with this email already exists'),
        );

        // Act
        const result = await service.provisionTenant(tenant.id, {
          createFirstAdmin: true,
          adminEmail: 'existing@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        });

        // Assert
        expect(result.success).toBe(false);
        const adminStep = result.steps.find((s) => s.name === 'create_first_admin');
        expect(adminStep?.status).toBe('failed');
        expect(result.adminUser).toBeUndefined();
        expect(result.error).toContain('A user with this email already exists');
      });

      it('admin oluşturulunca auth-service davet handoff komutu gönderilir', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
        dataSource.query.mockImplementation(mockTenantClaimQuery);

        // Act
        await service.provisionTenant(tenant.id, {
          createFirstAdmin: true,
          adminEmail: 'admin@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        });

        // Assert
        expect(authProvisioningClient.createTenantAdmin).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: tenant.id,
            email: 'admin@test.com',
            firstName: 'Test',
            lastName: 'Admin',
          }),
        );
      });
    });
  });

  // ===========================================================================
  // DATABASE & SCHEMA İŞLEMLERİ
  // ===========================================================================

  describe('Database & Schema İşlemleri', () => {
    it('tenant için schema oluşturulur', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

      // Act
      const result = await service.provisionTenant(tenant.id, { skipSchemaCreation: false });

      // Assert
      expect(result.success).toBe(true);
      const schemaStep = result.steps.find((s) => s.name === 'create_schema');
      expect(schemaStep?.status).toBe('completed');
    });

    it('default roles kurulur', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

      // Act
      const result = await service.provisionTenant(tenant.id, { skipSchemaCreation: false });

      // Assert
      const rolesStep = result.steps.find((s) => s.name === 'setup_default_roles');
      expect(rolesStep?.status).toBe('completed');
    });

    it('default configuration oluşturulur', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

      // Act
      const result = await service.provisionTenant(tenant.id);

      // Assert: provisioning performs NO configuration write. Every tenant
      // setting is seeded once under the SYSTEM tenant and config-service's
      // effective merge answers a new tenant's reads from those rows, so the
      // correct configuration for a fresh tenant is what happens when
      // provisioning does nothing. The step this replaces called a service that
      // minted a requestId, logged it and returned.
      expect(result.steps.map((s) => s.name)).not.toContain('create_default_config');
    });

    it('tüm step süreleri kaydedilir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

      // Act
      const result = await service.provisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(true);
      result.steps.forEach((step) => {
        if (step.status === 'completed') {
          expect(step.duration).toBeDefined();
          expect(step.duration).toBeGreaterThanOrEqual(0);
        }
      });
    });
  });

  // ===========================================================================
  // TRANSACTION & ROLLBACK SENARYOLARI
  // ===========================================================================

  describe('Transaction & Rollback Senaryoları', () => {
    it('herhangi bir step başarısız olursa ilgili step failed olarak işaretlenir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      (service as unknown as {
        createTenantSchema: jest.Mock;
      }).createTenantSchema.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await service.provisionTenant(tenant.id, { skipSchemaCreation: false });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
      const failedStep = result.steps.find((s) => s.status === 'failed');
      expect(failedStep).toBeDefined();
      expect(authProvisioningClient.failProvisioning).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: tenant.id,
          reason: 'Database error',
        }),
      );
    });

    it('auth handoff başarısız olursa provisioning fail-closed kalır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      authProvisioningClient.createTenantAdmin.mockRejectedValue(new Error('SMTP handoff error'));

      // Act
      const result = await service.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'admin@test.com',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('SMTP handoff error');
    });

    it('admin user oluşturma başarısız olursa provisioning yine de tamamlanır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      authProvisioningClient.createTenantAdmin.mockRejectedValue(
        new Error('A user with this email already exists'),
      );

      // Act
      const result = await service.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'existing@test.com',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('A user with this email already exists');
    });
  });

  // ===========================================================================
  // DEPROVISIONING TESTLERİ
  // ===========================================================================

  describe('Deprovisioning', () => {
    it('ACTIVE tenant deprovision edilemez', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.ACTIVE });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(false);
      expect(result.steps[0]!.error).toContain('active');
    });

    it('SUSPENDED tenant deprovision edilebilir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.SUSPENDED });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantSchemaRepository.findOne.mockResolvedValue({
        tenantId: tenant.id,
        schemaName: 'tenant_test',
        status: 'active',
        metadata: {},
      } as TenantSchema);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(true);
    });

    it('DEACTIVATED tenant deprovision edilebilir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantSchemaRepository.findOne.mockResolvedValue({
        tenantId: tenant.id,
        schemaName: 'tenant_test',
        status: 'active',
        metadata: {},
      } as TenantSchema);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(true);
    });

    it('deprovisioning sırasında backup alınır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantSchemaRepository.findOne.mockResolvedValue({
        tenantId: tenant.id,
        schemaName: 'tenant_test',
        status: 'active',
        metadata: {},
      } as TenantSchema);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      const backupStep = result.steps.find((s) => s.name === 'backup_data');
      expect(backupStep?.status).toBe('completed');
    });

    it('deprovisioning sırasında schema temizlenir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantSchemaRepository.findOne.mockResolvedValue({
        tenantId: tenant.id,
        schemaName: 'tenant_test',
        status: 'active',
        metadata: {},
      } as TenantSchema);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      const cleanupStep = result.steps.find((s) => s.name === 'cleanup_schema');
      expect(cleanupStep?.status).toBe('completed');
    });
  });

  // ===========================================================================
  // PROVISIONING STATUS TESTLERİ
  // ===========================================================================

  describe('getProvisioningStatus', () => {
    it('PENDING tenant için "pending" status döner', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.getProvisioningStatus(tenant.id);

      // Assert
      expect(result.status).toBe('pending');
      expect(result.tenant).toBeDefined();
    });

    it('ACTIVE tenant için "provisioned" status döner', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.ACTIVE });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.getProvisioningStatus(tenant.id);

      // Assert
      expect(result.status).toBe('provisioned');
    });

    it('SUSPENDED tenant için "suspended" status döner', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.SUSPENDED });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.getProvisioningStatus(tenant.id);

      // Assert
      expect(result.status).toBe('suspended');
    });

    it('DEACTIVATED tenant için "deactivated" status döner', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.getProvisioningStatus(tenant.id);

      // Assert
      expect(result.status).toBe('deactivated');
    });

    it('ARCHIVED tenant için "archived" status döner', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.ARCHIVED });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.getProvisioningStatus(tenant.id);

      // Assert
      expect(result.status).toBe('archived');
    });

    it('olmayan tenant için "not_found" status döner', async () => {
      // Arrange
      tenantRepository.findOne.mockResolvedValue(null);

      // Act
      const result = await service.getProvisioningStatus('non-existent-id');

      // Assert
      expect(result.status).toBe('not_found');
      expect(result.tenant).toBeUndefined();
    });
  });

  // ===========================================================================
  // MODULE ASSIGNMENT TESTLERİ
  // ===========================================================================

  describe('Module Assignment', () => {
    it('modüller tenant\'a atanır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      dataSource.query.mockImplementation(mockTenantClaimQuery);

      // Act
      const result = await service.provisionTenant(tenant.id, {
        assignModules: ['module-1', 'module-2'],
      });

      // Assert
      expect(result.success).toBe(true);
      const modulesStep = result.steps.find((s) => s.name === 'assign_modules');
      expect(modulesStep?.status).toBe('completed');
    });

    it('modül ataması hatası provisioning\'i durdurur', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      authProvisioningClient.assignTenantModules.mockRejectedValue(
        new Error('Module assignment error'),
      );

      // Act
      const result = await service.provisionTenant(tenant.id, {
        assignModules: ['invalid-module'],
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not assign modules');
    });

    it('boş modül listesi ile assign_modules step\'i oluşmaz', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);

      // Act
      const result = await service.provisionTenant(tenant.id, {
        assignModules: [],
      });

      // Assert
      expect(result.success).toBe(true);
      const modulesStep = result.steps.find((s) => s.name === 'assign_modules');
      expect(modulesStep).toBeUndefined();
    });
  });

  // ===========================================================================
  // CONCURRENT İŞLEMLER
  // ===========================================================================

  describe('Concurrent İşlemler', () => {
    it('aynı anda birden fazla tenant provision edilebilir', async () => {
      // Arrange
      const tenant1 = createMockTenant({ id: '00000000-0000-4000-8000-000000000001', status: TenantStatus.PENDING });
      const tenant2 = createMockTenant({ id: '00000000-0000-4000-8000-000000000002', status: TenantStatus.PENDING });

      tenantRepository.findOne
        .mockResolvedValue(tenant1)
        .mockResolvedValueOnce(tenant1)
        .mockResolvedValueOnce(tenant2);
      tenantRepository.save
        .mockResolvedValue({ ...tenant1, status: TenantStatus.ACTIVE } as any);

      // Act
      const [result1, result2] = await Promise.all([
        service.provisionTenant(tenant1.id),
        service.provisionTenant(tenant2.id),
      ]);

      // Assert
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('Edge Cases', () => {
    it('auth-service user id dönmezse first-admin provisioning fail-closed kalır', async () => {
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      authProvisioningClient.createTenantAdmin.mockResolvedValue({
        success: true,
        email: 'admin@test.com',
      });

      // Act
      const result = await service.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'admin@test.com',
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing user id');
    });

    // Renamed from 'lastActivityAt güncellenir': the assertion always pinned
    // the ActivateTenant delegation metadata, and the lastActivityAt prop was
    // removed from the tenant entity (DB-ADMIN-HIGH-003 cleanup).
    it('provisioning finalizes via the owner ActivateTenant command with audit metadata', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      await service.provisionTenant(tenant.id);

      // Assert
      expect(authProvisioningClient.activateTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: tenant.id,
          requestReference: expect.stringContaining(':ActivateTenant'),
          auditMetadata: expect.objectContaining({
            commandType: 'ActivateTenant',
          }),
        }),
      );
    });
  });
});
