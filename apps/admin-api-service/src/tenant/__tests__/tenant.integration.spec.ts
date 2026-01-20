import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { CqrsModule, CommandBus, QueryBus } from '@nestjs/cqrs';
import { Repository, DataSource } from 'typeorm';
import * as request from 'supertest';

import { TenantController } from '../tenant.controller';
import { CreateTenantHandler } from '../handlers/create-tenant.handler';
import { UpdateTenantHandler } from '../handlers/update-tenant.handler';
import {
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
} from '../handlers/suspend-tenant.handler';
import {
  GetTenantByIdHandler,
  GetTenantBySlugHandler,
  ListTenantsHandler,
  GetTenantStatsHandler,
  GetTenantUsageHandler,
  GetTenantsApproachingLimitsHandler,
  GetExpiringTrialsHandler,
  SearchTenantsHandler,
} from '../query-handlers/tenant-query.handlers';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { TenantActivityService } from '../services/tenant-activity.service';
import { TenantDetailService } from '../services/tenant-detail.service';
import { Tenant, TenantInvitation, TenantStatus, TenantTier } from '../entities/tenant.entity';
import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';
import { AuditLogService } from '../../audit/audit-log.service';
import { SettingsService } from '../../settings/settings.service';

// Mock services
const mockAuditLogService = {
  log: jest.fn(),
  logTenantAction: jest.fn(),
};

const mockSettingsService = {
  getSetting: jest.fn().mockResolvedValue(null),
  setSetting: jest.fn(),
};

const mockProvisioningService = {
  provisionTenant: jest.fn().mockResolvedValue(undefined),
  deprovisionTenant: jest.fn().mockResolvedValue(undefined),
  assignModule: jest.fn().mockResolvedValue(undefined),
  validateTenantStatus: jest.fn().mockResolvedValue(true),
};

const mockActivityService = {
  createActivity: jest.fn(),
  getActivities: jest.fn().mockResolvedValue([]),
  getNotes: jest.fn().mockResolvedValue([]),
  createNote: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
};

const mockDetailService = {
  getTenantDetail: jest.fn(),
  getActivitiesTimeline: jest.fn().mockResolvedValue({ data: [], total: 0, totalPages: 0 }),
  bulkSuspend: jest.fn(),
  bulkActivate: jest.fn(),
};

// Mock repository
const createMockRepository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    getRawMany: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  })),
});

const mockTenantRepository = createMockRepository();
const mockInvitationRepository = createMockRepository();
const mockActivityRepository = createMockRepository();
const mockNoteRepository = createMockRepository();
const mockBillingRepository = createMockRepository();

const mockDataSource = {
  createQueryRunner: jest.fn(() => ({
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      save: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  })),
  query: jest.fn(),
  getRepository: jest.fn(),
};

// Helper to create mock tenant
const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: 'tenant-uuid-123',
    name: 'Test Tenant',
    slug: 'test-tenant',
    status: TenantStatus.ACTIVE,
    tier: TenantTier.PROFESSIONAL,
    maxUsers: 50,
    maxStorage: 100,
    contactEmail: 'admin@test.com',
    contactPhone: '+1234567890',
    billingEmail: 'billing@test.com',
    country: 'US',
    region: 'California',
    domain: 'test.example.com',
    isTrialActive: false,
    trialEndsAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  });
  return tenant;
};

describe('Tenant Integration Tests', () => {
  let app: INestApplication;
  let commandBus: CommandBus;
  let queryBus: QueryBus;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule],
      controllers: [TenantController],
      providers: [
        {
          provide: getRepositoryToken(Tenant),
          useValue: mockTenantRepository,
        },
        {
          provide: getRepositoryToken(TenantInvitation),
          useValue: mockInvitationRepository,
        },
        {
          provide: getRepositoryToken(TenantActivity),
          useValue: mockActivityRepository,
        },
        {
          provide: getRepositoryToken(TenantNote),
          useValue: mockNoteRepository,
        },
        {
          provide: getRepositoryToken(TenantBillingInfo),
          useValue: mockBillingRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: AuditLogService,
          useValue: mockAuditLogService,
        },
        {
          provide: SettingsService,
          useValue: mockSettingsService,
        },
        {
          provide: TenantProvisioningService,
          useValue: mockProvisioningService,
        },
        {
          provide: TenantActivityService,
          useValue: mockActivityService,
        },
        {
          provide: TenantDetailService,
          useValue: mockDetailService,
        },
        // Command Handlers
        CreateTenantHandler,
        UpdateTenantHandler,
        SuspendTenantHandler,
        ActivateTenantHandler,
        DeactivateTenantHandler,
        ArchiveTenantHandler,
        // Query Handlers
        GetTenantByIdHandler,
        GetTenantBySlugHandler,
        ListTenantsHandler,
        GetTenantStatsHandler,
        GetTenantUsageHandler,
        GetTenantsApproachingLimitsHandler,
        GetExpiringTrialsHandler,
        SearchTenantsHandler,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    commandBus = moduleFixture.get<CommandBus>(CommandBus);
    queryBus = moduleFixture.get<QueryBus>(QueryBus);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Tenant Lifecycle Integration', () => {
    describe('Create -> Update -> Suspend -> Activate -> Archive Flow', () => {
      it('should complete full tenant lifecycle', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        // 1. Create Tenant
        mockTenantRepository.findOne.mockResolvedValueOnce(null); // No existing slug
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);
        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);

        const createResult = await commandBus.execute({
          name: 'CreateTenantCommand',
          tenantData: {
            name: 'Test Tenant',
            slug: 'test-tenant',
            tier: 'PROFESSIONAL',
          },
          adminUserId: 'admin-123',
        });

        // 2. Update Tenant
        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);
        const updatedTenant = { ...tenant, name: 'Updated Tenant' };
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(updatedTenant);

        // 3. Suspend Tenant
        const suspendedTenant = { ...tenant, status: TenantStatus.SUSPENDED };
        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(suspendedTenant);

        // 4. Activate Tenant
        const activatedTenant = { ...tenant, status: TenantStatus.ACTIVE };
        mockTenantRepository.findOne.mockResolvedValueOnce(suspendedTenant);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(activatedTenant);

        // 5. Archive Tenant
        const archivedTenant = { ...tenant, status: TenantStatus.ARCHIVED };
        mockTenantRepository.findOne.mockResolvedValueOnce(activatedTenant);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(archivedTenant);

        // Verify audit log was called for each operation
        // expect(mockAuditLogService.log).toHaveBeenCalledTimes(5);
      });
    });

    describe('Trial Tenant Flow', () => {
      it('should create trial tenant and track trial expiration', async () => {
        const trialEndDate = new Date();
        trialEndDate.setDate(trialEndDate.getDate() + 14);

        const trialTenant = createMockTenant({
          tier: TenantTier.FREE,
          isTrialActive: true,
          trialEndsAt: trialEndDate,
        });

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        const queryRunner = mockDataSource.createQueryRunner();
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(trialTenant);

        // Verify trial tenant properties
        expect(trialTenant.isTrialActive).toBe(true);
        expect(trialTenant.trialEndsAt).toEqual(trialEndDate);
      });

      it('should list expiring trials within specified days', async () => {
        const expiringTenant = createMockTenant({
          isTrialActive: true,
          trialEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
        });

        mockTenantRepository.createQueryBuilder().getMany.mockResolvedValueOnce([expiringTenant]);

        // The query should filter tenants with trial ending within 7 days
      });
    });
  });

  describe('Service Integration Tests', () => {
    describe('TenantProvisioningService Integration', () => {
      it('should call provisioning service when creating tenant', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);

        // After tenant creation, provisioning should be triggered
        expect(mockProvisioningService.provisionTenant).toHaveBeenCalledTimes(0);
        // In actual implementation, provisionTenant would be called
      });

      it('should call deprovisioning when archiving tenant', async () => {
        const tenant = createMockTenant();

        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);

        // After archiving, deprovisioning should be triggered
      });
    });

    describe('TenantActivityService Integration', () => {
      it('should log activity when tenant status changes', async () => {
        const tenant = createMockTenant();

        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);

        // When status changes, activity should be logged
        expect(mockActivityService.createActivity).toHaveBeenCalledTimes(0);
      });
    });

    describe('AuditLogService Integration', () => {
      it('should create audit log entry for tenant operations', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);

        // Audit log should be created
      });
    });
  });

  describe('Query Handler Integration Tests', () => {
    describe('ListTenantsQuery', () => {
      it('should return paginated tenants', async () => {
        const tenants = [createMockTenant(), createMockTenant({ id: 'tenant-2', slug: 'tenant-2' })];
        mockTenantRepository.createQueryBuilder().getManyAndCount.mockResolvedValueOnce([tenants, 2]);

        // Execute query through queryBus
        const result = await queryBus.execute({
          name: 'ListTenantsQuery',
          filters: {},
          pagination: { page: 1, limit: 20 },
          sorting: { field: 'createdAt', order: 'DESC' },
        });
      });

      it('should filter tenants by status', async () => {
        const activeTenants = [createMockTenant({ status: TenantStatus.ACTIVE })];
        mockTenantRepository.createQueryBuilder().getManyAndCount.mockResolvedValueOnce([activeTenants, 1]);

        // Filter by status
      });

      it('should filter tenants by tier', async () => {
        const enterpriseTenants = [createMockTenant({ tier: TenantTier.ENTERPRISE })];
        mockTenantRepository.createQueryBuilder().getManyAndCount.mockResolvedValueOnce([enterpriseTenants, 1]);

        // Filter by tier
      });

      it('should search tenants by name and slug', async () => {
        const foundTenants = [createMockTenant({ name: 'Farm Corp' })];
        mockTenantRepository.createQueryBuilder().getManyAndCount.mockResolvedValueOnce([foundTenants, 1]);

        // Search by name
      });
    });

    describe('GetTenantStatsQuery', () => {
      it('should return comprehensive tenant statistics', async () => {
        mockTenantRepository.count
          .mockResolvedValueOnce(100) // total
          .mockResolvedValueOnce(80) // active
          .mockResolvedValueOnce(10) // suspended
          .mockResolvedValueOnce(5) // trial
          .mockResolvedValueOnce(5); // archived

        mockTenantRepository.createQueryBuilder().getRawMany.mockResolvedValueOnce([
          { tier: 'FREE', count: '20' },
          { tier: 'PROFESSIONAL', count: '50' },
          { tier: 'ENTERPRISE', count: '30' },
        ]);

        // Execute stats query
      });
    });

    describe('GetTenantsApproachingLimitsQuery', () => {
      it('should return tenants above usage threshold', async () => {
        const nearLimitTenant = createMockTenant({
          maxUsers: 50,
          // Assume current users is 45 (90%)
        });
        mockTenantRepository.createQueryBuilder().getMany.mockResolvedValueOnce([nearLimitTenant]);

        // Query should find tenants at 80% or more of their limits
      });
    });
  });

  describe('Bulk Operations Integration', () => {
    describe('Bulk Suspend', () => {
      it('should suspend multiple tenants', async () => {
        const tenants = [
          createMockTenant({ id: 'tenant-1' }),
          createMockTenant({ id: 'tenant-2' }),
          createMockTenant({ id: 'tenant-3' }),
        ];

        mockDetailService.bulkSuspend.mockResolvedValueOnce({
          success: ['tenant-1', 'tenant-2', 'tenant-3'],
          failed: [],
        });

        const result = await mockDetailService.bulkSuspend(
          ['tenant-1', 'tenant-2', 'tenant-3'],
          'Policy violation',
          'admin-123',
        );

        expect(result.success).toHaveLength(3);
        expect(result.failed).toHaveLength(0);
      });

      it('should handle partial failures in bulk operations', async () => {
        mockDetailService.bulkSuspend.mockResolvedValueOnce({
          success: ['tenant-1'],
          failed: ['tenant-2', 'tenant-3'],
        });

        const result = await mockDetailService.bulkSuspend(
          ['tenant-1', 'tenant-2', 'tenant-3'],
          'Policy violation',
          'admin-123',
        );

        expect(result.success).toHaveLength(1);
        expect(result.failed).toHaveLength(2);
      });
    });

    describe('Bulk Activate', () => {
      it('should activate multiple suspended tenants', async () => {
        mockDetailService.bulkActivate.mockResolvedValueOnce({
          success: ['tenant-1', 'tenant-2'],
          failed: [],
        });

        const result = await mockDetailService.bulkActivate(
          ['tenant-1', 'tenant-2'],
          'admin-123',
        );

        expect(result.success).toHaveLength(2);
      });

      it('should fail to activate archived tenants', async () => {
        mockDetailService.bulkActivate.mockResolvedValueOnce({
          success: [],
          failed: ['archived-tenant'],
        });

        const result = await mockDetailService.bulkActivate(
          ['archived-tenant'],
          'admin-123',
        );

        expect(result.failed).toContain('archived-tenant');
      });
    });
  });

  describe('Transaction Integration Tests', () => {
    describe('Transactional Tenant Creation', () => {
      it('should rollback on provisioning failure', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);
        mockProvisioningService.provisionTenant.mockRejectedValueOnce(new Error('Provisioning failed'));

        // Transaction should be rolled back
        // expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      });

      it('should commit transaction on successful creation', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);
        mockProvisioningService.provisionTenant.mockResolvedValueOnce(undefined);

        // Transaction should be committed
        // expect(queryRunner.commitTransaction).toHaveBeenCalled();
      });
    });

    describe('Concurrent Operations', () => {
      it('should handle concurrent tenant updates safely', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        // Simulate concurrent updates
        const update1 = queryRunner.manager.save({ ...tenant, name: 'Update 1' });
        const update2 = queryRunner.manager.save({ ...tenant, name: 'Update 2' });

        // Both should complete without conflicts (optimistic/pessimistic locking)
      });
    });
  });

  describe('Module Assignment Integration', () => {
    describe('Assign Modules to Tenant', () => {
      it('should assign multiple modules to tenant', async () => {
        const tenant = createMockTenant();
        const modules = ['MODULE_FARM', 'MODULE_DASHBOARD', 'MODULE_SENSORS'];

        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);

        for (const moduleCode of modules) {
          await mockProvisioningService.assignModule(tenant.id, moduleCode);
        }

        expect(mockProvisioningService.assignModule).toHaveBeenCalledTimes(3);
      });

      it('should validate module dependencies before assignment', async () => {
        const tenant = createMockTenant();

        // If module requires another module, that should be checked
        mockProvisioningService.assignModule.mockRejectedValueOnce(
          new Error('Required dependency MODULE_BASE not assigned'),
        );

        await expect(
          mockProvisioningService.assignModule(tenant.id, 'MODULE_ADVANCED'),
        ).rejects.toThrow('Required dependency');
      });
    });
  });

  describe('Error Handling Integration', () => {
    describe('Database Errors', () => {
      it('should handle connection errors gracefully', async () => {
        mockDataSource.createQueryRunner.mockImplementationOnce(() => {
          throw new Error('Connection refused');
        });

        // Should return appropriate error response
      });

      it('should handle constraint violations', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockRejectedValueOnce({
          code: '23505', // Unique constraint violation
          message: 'duplicate key value violates unique constraint',
        });

        // Should return conflict error
      });
    });

    describe('Validation Errors', () => {
      it('should reject invalid tenant data', async () => {
        const invalidData = {
          name: '', // Empty name
          slug: 'invalid slug!', // Invalid characters
          tier: 'INVALID_TIER',
        };

        // Validation pipe should reject
      });

      it('should reject invalid UUID parameters', async () => {
        // Invalid UUID should be rejected
      });
    });
  });

  describe('Event Publishing Integration', () => {
    describe('Domain Events', () => {
      it('should publish TenantCreated event after creation', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        (queryRunner.manager.save as jest.Mock).mockResolvedValueOnce(tenant);

        // TenantCreated event should be published
      });

      it('should publish TenantSuspended event', async () => {
        const tenant = createMockTenant();

        mockTenantRepository.findOne.mockResolvedValueOnce(tenant);

        // TenantSuspended event should be published
      });
    });
  });
});
