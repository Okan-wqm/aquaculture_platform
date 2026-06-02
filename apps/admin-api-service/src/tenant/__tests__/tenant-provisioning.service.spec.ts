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

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { AUTH_ADMIN_COMMAND_SUBJECTS } from '@platform/event-contracts';
import { Repository, DataSource, QueryRunner } from 'typeorm';

import { BackupRestoreService } from '../../database-management/services/backup-restore.service';
import { EmailSenderService } from '../../settings/services/email-sender.service';
import { TenantSchema } from '../../database-management/entities/database-management.entity';
import { TenantConfigurationService } from '../../settings/services/tenant-configuration.service';
import { RoleTemplateService } from '../../users/services/role-template.service';
import { UserPermissionsService } from '../../users/services/user-permissions.service';
import { Tenant, TenantStatus, TenantTier, TenantPlan } from '../entities/tenant.entity';
import { AuthCommandClientService } from '../../auth/auth-command-client.service';
import {
  TenantProvisioningService,
  ProvisioningResult,
  TenantProvisioningOptions,
} from '../services/tenant-provisioning.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { randomUUID: uuidv4 } = require('crypto');

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  // Extract 'limits' from overrides since it's a getter-only property on Tenant
  const { limits: _limits, ...safeOverrides } = overrides as any;
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
    isTrialActive: false,
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

const mockAuthCommandClient = {
  request: jest.fn(),
  assertSuccess: jest.fn(),
};

const successfulAuthCommandResult = async (
  subject: string,
  command: Record<string, any>,
): Promise<Record<string, any>> => {
  switch (subject) {
    case AUTH_ADMIN_COMMAND_SUBJECTS.CLAIM_TENANT_PROVISIONING:
      return { success: true, claimed: true };
    case AUTH_ADMIN_COMMAND_SUBJECTS.SETUP_TENANT_ROLES:
      return { success: true, rolesCreated: command['roles']?.length ?? 1 };
    case AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN:
      return {
        success: true,
        userId: 'new-user-id',
        email: command['email'],
        invitationToken: 'tenant-admin-invitation-token',
      };
    case AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES:
      return { success: true, modulesAssigned: command['modules']?.length ?? 0 };
    case AUTH_ADMIN_COMMAND_SUBJECTS.SET_TENANT_STATUS:
      return { success: true, updated: true };
    case AUTH_ADMIN_COMMAND_SUBJECTS.REMOVE_TENANT_AUTH_RESOURCES:
      return { success: true };
    default:
      return { success: true };
  }
};

const authAssertSuccess = (result: any, fallback?: string): any => {
  if (result.success) return result;
  throw new Error(result.error || fallback || 'Auth command failed');
};

// =============================================================================
// Test Suite
// =============================================================================

describe('TenantProvisioningService', () => {
  let service: TenantProvisioningService;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let dataSource: jest.Mocked<DataSource>;
  let emailSenderService: jest.Mocked<EmailSenderService>;
  let queryRunner: jest.Mocked<Partial<QueryRunner>>;

  beforeEach(async () => {
    queryRunner = createMockQueryRunner();
    mockAuthCommandClient.request.mockReset();
    mockAuthCommandClient.assertSuccess.mockReset();
    mockAuthCommandClient.request.mockImplementation(successfulAuthCommandResult);
    mockAuthCommandClient.assertSuccess.mockImplementation(authAssertSuccess);

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: jest.fn().mockResolvedValue([]),
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

    const mockEmailSenderService = {
      sendInvitationEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'test-msg-id' }),
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
      testConnection: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockTenantConfigurationService = {
      createConfiguration: jest.fn().mockResolvedValue(undefined),
      getConfiguration: jest.fn().mockResolvedValue({}),
    };

    const mockRoleTemplateService = {
      createDefaultRoles: jest.fn().mockResolvedValue(undefined),
      getRoleTemplates: jest.fn().mockResolvedValue([]),
    };

    const mockUserPermissionsService = {
      createDefaultPermissions: jest.fn().mockResolvedValue(undefined),
    };

    const mockBackupRestoreService = {
      createBackup: jest.fn().mockResolvedValue({ status: 'completed' }),
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
          provide: EmailSenderService,
          useValue: mockEmailSenderService,
        },
        {
          provide: TenantConfigurationService,
          useValue: mockTenantConfigurationService,
        },
        {
          provide: RoleTemplateService,
          useValue: mockRoleTemplateService,
        },
        {
          provide: UserPermissionsService,
          useValue: mockUserPermissionsService,
        },
        {
          provide: BackupRestoreService,
          useValue: mockBackupRestoreService,
        },
        {
          provide: AuthCommandClientService,
          useValue: mockAuthCommandClient,
        },
      ],
    }).compile();

    service = module.get<TenantProvisioningService>(TenantProvisioningService);
    (service as any).schemaManager = {
      createTenantSchema: jest.fn().mockResolvedValue({
        success: true,
        schemaName: 'tenant_test_tenant',
        tablesCreated: ['farms', 'ponds'],
        duration: 10,
      }),
      deleteTenantSchema: jest.fn().mockResolvedValue({ success: true }),
    };
    tenantRepository = module.get(getRepositoryToken(Tenant));
    dataSource = module.get(getDataSourceToken());
    emailSenderService = module.get(EmailSenderService);
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
        expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
          AUTH_ADMIN_COMMAND_SUBJECTS.CLAIM_TENANT_PROVISIONING,
          expect.objectContaining({
            tenantId: tenant.id,
            provisioningStatus: TenantStatus.PROVISIONING,
          }),
        );
        expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
          AUTH_ADMIN_COMMAND_SUBJECTS.SETUP_TENANT_ROLES,
          expect.objectContaining({ tenantId: tenant.id }),
        );
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
        tenantRepository.save.mockImplementation(
          async (t) =>
            ({
              ...t,
              status: TenantStatus.ACTIVE,
            }) as any,
        );

        // Act
        const result = await service.provisionTenant(tenant.id);

        // Assert
        expect(result.success).toBe(true);
        expect(tenantRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: TenantStatus.ACTIVE }),
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
        dataSource.query.mockResolvedValue([]);
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
        expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
          AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN,
          {
            tenantId: tenant.id,
            email: 'admin@test.com',
            firstName: 'Test',
            lastName: 'Admin',
          },
        );
      });

      it('email zaten kayıtlıysa admin user oluşturulmaz', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
        mockAuthCommandClient.request.mockImplementation(async (subject, command) => {
          if (subject === AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN) {
            return {
              success: false,
              errorCode: 'DUPLICATE_EMAIL',
              error: 'A user with this email already exists',
            };
          }
          return successfulAuthCommandResult(subject, command);
        });

        // Act
        const result = await service.provisionTenant(tenant.id, {
          createFirstAdmin: true,
          adminEmail: 'existing@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        });

        // Assert
        expect(result.success).toBe(true);
        const adminStep = result.steps.find((s) => s.name === 'create_first_admin');
        expect(adminStep?.status).toBe('completed');
        expect(result.adminUser).toBeUndefined();
        expect(result.warnings?.[0]).toContain('A user with this email already exists');
        expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
          AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN,
          expect.objectContaining({ email: 'existing@test.com' }),
        );
      });

      it('admin oluşturulunca davet emaili gönderilir', async () => {
        // Arrange
        const tenant = createMockTenant({ status: TenantStatus.PENDING });
        tenantRepository.findOne.mockResolvedValue(tenant);
        tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
        dataSource.query.mockResolvedValue([]);
        (dataSource.transaction as jest.Mock).mockImplementation(async (callback: any) => {
          return callback({
            query: jest
              .fn()
              .mockResolvedValueOnce([{ id: 'new-user-id' }])
              .mockResolvedValue([]),
          });
        });

        // Act
        await service.provisionTenant(tenant.id, {
          createFirstAdmin: true,
          adminEmail: 'admin@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        });

        // Assert
        expect(emailSenderService.sendInvitationEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            email: 'admin@test.com',
            firstName: 'Test',
            lastName: 'Admin',
            tenantName: tenant.name,
            role: 'TENANT_ADMIN',
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
      const result = await service.provisionTenant(tenant.id);

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
      const result = await service.provisionTenant(tenant.id);

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

      // Assert
      const configStep = result.steps.find((s) => s.name === 'create_default_config');
      expect(configStep?.status).toBe('completed');
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
      tenantRepository.save.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await service.provisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
      const failedStep = result.steps.find((s) => s.status === 'failed');
      expect(failedStep).toBeDefined();
    });

    it('email gönderme başarısız olsa bile provisioning devam eder', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      dataSource.query.mockResolvedValue([]);
      (dataSource.transaction as jest.Mock).mockImplementation(async (callback: any) => {
        return callback({
          query: jest
            .fn()
            .mockResolvedValueOnce([{ id: 'new-user-id' }])
            .mockResolvedValue([]),
        });
      });
      emailSenderService.sendInvitationEmail.mockResolvedValue({
        success: false,
        error: 'SMTP error',
      });

      // Act
      const result = await service.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'admin@test.com',
      });

      // Assert
      expect(result.success).toBe(true);
    });

    it('admin user oluşturma başarısız olursa provisioning yine de tamamlanır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      mockAuthCommandClient.request.mockImplementation(async (subject, command) => {
        if (subject === AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN) {
          return {
            success: false,
            errorCode: 'DUPLICATE_EMAIL',
            error: 'A user with this email already exists',
          };
        }
        return successfulAuthCommandResult(subject, command);
      });

      // Act
      const result = await service.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'existing@test.com',
      });

      // Assert
      expect(result.success).toBe(true);
      const activateStep = result.steps.find((s) => s.name === 'activate_tenant');
      expect(activateStep?.status).toBe('completed');
      expect(result.adminUser).toBeUndefined();
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

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(true);
    });

    it('DEACTIVATED tenant deprovision edilebilir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);

      // Act
      const result = await service.deprovisionTenant(tenant.id);

      // Assert
      expect(result.success).toBe(true);
    });

    it('deprovisioning sırasında backup alınır', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
      tenantRepository.findOne.mockResolvedValue(tenant);

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
    it("modüller tenant'a atanır", async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      dataSource.query.mockResolvedValue([]);

      // Act
      const result = await service.provisionTenant(tenant.id, {
        assignModules: ['module-1', 'module-2'],
      });

      // Assert
      expect(result.success).toBe(true);
      const modulesStep = result.steps.find((s) => s.name === 'assign_modules');
      expect(modulesStep?.status).toBe('completed');
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES,
        {
          tenantId: tenant.id,
          modules: [
            { moduleId: 'module-1', assignedBy: tenant.id },
            { moduleId: 'module-2', assignedBy: tenant.id },
          ],
        },
      );
    });

    it("modül ataması hatası provisioning'i durdurur", async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      mockAuthCommandClient.request.mockImplementation(async (subject, command) => {
        if (subject === AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES) {
          return {
            success: false,
            errorCode: 'MODULE_NOT_FOUND',
            error: 'Module assignment error',
          };
        }
        return successfulAuthCommandResult(subject, command);
      });

      // Act
      const result = await service.provisionTenant(tenant.id, {
        assignModules: ['invalid-module'],
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not assign modules');
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES,
        expect.objectContaining({ tenantId: tenant.id }),
      );
    });

    it("boş modül listesi ile assign_modules step'i oluşmaz", async () => {
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
      const tenant1 = createMockTenant({
        id: '00000000-0000-4000-8000-000000000001',
        status: TenantStatus.PENDING,
      });
      const tenant2 = createMockTenant({
        id: '00000000-0000-4000-8000-000000000002',
        status: TenantStatus.PENDING,
      });

      tenantRepository.findOne
        .mockResolvedValue(tenant1)
        .mockResolvedValueOnce(tenant1)
        .mockResolvedValueOnce(tenant2);
      tenantRepository.save.mockResolvedValue({ ...tenant1, status: TenantStatus.ACTIVE } as any);

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
    it('EmailSenderService yoksa provisioning yine de tamamlanır', async () => {
      // Bu test için EmailSenderService'i undefined yaparak yeni bir module oluşturmalıyız
      const moduleWithoutEmail: TestingModule = await Test.createTestingModule({
        providers: [
          TenantProvisioningService,
          {
            provide: getRepositoryToken(Tenant),
            useValue: tenantRepository,
          },
          {
            provide: getRepositoryToken(TenantSchema),
            useValue: {
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn((entity) => entity),
              save: jest.fn().mockImplementation(async (entity) => entity),
              update: jest.fn(),
            },
          },
          {
            provide: getDataSourceToken(),
            useValue: dataSource,
          },
          {
            provide: TenantConfigurationService,
            useValue: {
              createConfiguration: jest.fn().mockResolvedValue(undefined),
              getConfiguration: jest.fn().mockResolvedValue({}),
            },
          },
          {
            provide: RoleTemplateService,
            useValue: {
              createDefaultRoles: jest.fn().mockResolvedValue(undefined),
              getRoleTemplates: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: UserPermissionsService,
            useValue: { createDefaultPermissions: jest.fn().mockResolvedValue(undefined) },
          },
          {
            provide: BackupRestoreService,
            useValue: { createBackup: jest.fn().mockResolvedValue({ status: 'completed' }) },
          },
          {
            provide: AuthCommandClientService,
            useValue: mockAuthCommandClient,
          },
          // EmailSenderService yok
        ],
      }).compile();

      const serviceWithoutEmail =
        moduleWithoutEmail.get<TenantProvisioningService>(TenantProvisioningService);
      (serviceWithoutEmail as any).schemaManager = {
        createTenantSchema: jest.fn().mockResolvedValue({
          success: true,
          schemaName: 'tenant_test_tenant',
          tablesCreated: ['farms', 'ponds'],
          duration: 10,
        }),
        deleteTenantSchema: jest.fn().mockResolvedValue({ success: true }),
      };

      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockResolvedValue({ ...tenant, status: TenantStatus.ACTIVE } as any);
      dataSource.query.mockResolvedValue([]);
      (dataSource.transaction as jest.Mock).mockImplementation(async (callback: any) => {
        return callback({
          query: jest
            .fn()
            .mockResolvedValueOnce([{ id: 'new-user-id' }])
            .mockResolvedValue([]),
        });
      });

      // Act
      const result = await serviceWithoutEmail.provisionTenant(tenant.id, {
        createFirstAdmin: true,
        adminEmail: 'admin@test.com',
      });

      // Assert
      expect(result.success).toBe(true);
    });

    it('lastActivityAt güncellenir', async () => {
      // Arrange
      const tenant = createMockTenant({ status: TenantStatus.PENDING });
      tenantRepository.findOne.mockResolvedValue(tenant);
      tenantRepository.save.mockImplementation(async (t) => t as any);

      // Act
      await service.provisionTenant(tenant.id);

      // Assert
      expect(tenantRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastActivityAt: expect.any(Date),
        }),
      );
    });
  });
});
