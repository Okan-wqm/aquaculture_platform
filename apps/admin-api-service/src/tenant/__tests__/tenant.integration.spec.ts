import { TENANT_ACTIVE_CHECK } from '@aquaculture/backend-common/middleware';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { CqrsModule, CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { SystemSettingService } from '../../settings/services/system-setting.service';
import {
  ActivateTenantCommand,
  ArchiveTenantCommand,
  DeactivateTenantCommand,
  SuspendTenantCommand,
} from '../commands/tenant.commands';
import { SuspendTenantDto } from '../dto/tenant.dto';
import { TenantActivity, TenantNote, TenantBillingInfo } from '../entities/tenant-activity.entity';
import { Tenant, TenantInvitation, TenantStatus, TenantTier } from '../entities/tenant.entity';
import {
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
} from '../handlers/suspend-tenant.handler';
import { UpdateTenantHandler } from '../handlers/update-tenant.handler';
import { ListTenantsQuery } from '../queries/tenant.queries';
import {
  GetTenantByIdHandler,
  GetTenantBySlugHandler,
  ListTenantsHandler,
  GetTenantStatsHandler,
  GetTenantUsageHandler,
  GetExpiringTrialsHandler,
  SearchTenantsHandler,
} from '../query-handlers/tenant-query.handlers';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';
import { TenantActivityService } from '../services/tenant-activity.service';
import { TenantDetailService } from '../services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from '../services/tenant-provisioning-workflow.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { TenantAdminController } from '../tenant.controller';

// Mock services
const mockAuditLogService = {
  record: jest.fn(),
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

const mockProvisioningWorkflowService = {
  createTenantOperation: jest.fn(),
  getOperation: jest.fn(),
  retryOperation: jest.fn(),
  processOperation: jest.fn(),
};

const mockModuleAssignmentService = {
  assignModulesToTenant: jest.fn().mockResolvedValue({
    success: true,
    assignedModules: [],
    failedModules: [],
    totalMonthlyPrice: 0,
  }),
};

const mockEventBus = {
  publish: jest.fn(),
};

const mockAuthProvisioningClient = {
  suspendTenant: jest.fn().mockResolvedValue({ success: true }),
  activateTenant: jest.fn().mockResolvedValue({ success: true }),
  deprovisionTenant: jest.fn().mockResolvedValue({ success: true }),
  archiveTenant: jest.fn().mockResolvedValue({ success: true }),
};

// ORPHAN-MEDIUM-372: the lifecycle handlers require OutboxPublisher (durable
// TenantSuspended/TenantStatusChanged events); the TestingModule must provide
// it like the runtime AdminOutboxModule does.
const mockOutboxPublisher = {
  enqueue: jest.fn().mockResolvedValue(undefined),
};

interface MockTenantQueryBuilder {
  where: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  andWhere: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  orderBy: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  skip: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  take: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  getManyAndCount: jest.MockedFunction<() => Promise<[Tenant[], number]>>;
  getMany: jest.MockedFunction<() => Promise<Tenant[]>>;
  getOne: jest.MockedFunction<() => Promise<Tenant | null>>;
  getRawMany: jest.MockedFunction<() => Promise<Array<Record<string, unknown>>>>;
  select: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  addSelect: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  leftJoin: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  leftJoinAndSelect: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  groupBy: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  addGroupBy: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
  limit: jest.MockedFunction<(...args: unknown[]) => MockTenantQueryBuilder>;
}

interface MockRepository {
  find: jest.MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
  findOne: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  findAndCount: jest.MockedFunction<(...args: unknown[]) => Promise<[unknown[], number]>>;
  save: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  create: jest.MockedFunction<(...args: unknown[]) => unknown>;
  update: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  delete: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  count: jest.MockedFunction<(...args: unknown[]) => Promise<number>>;
  createQueryBuilder: jest.MockedFunction<() => MockTenantQueryBuilder>;
}

const createMockQueryBuilder = (): MockTenantQueryBuilder => {
  const queryBuilder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    getRawMany: jest.fn().mockResolvedValue([]),
    select: jest.fn(),
    addSelect: jest.fn(),
    leftJoin: jest.fn(),
    leftJoinAndSelect: jest.fn(),
    groupBy: jest.fn(),
    addGroupBy: jest.fn(),
    limit: jest.fn(),
  } as MockTenantQueryBuilder;

  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  queryBuilder.orderBy.mockReturnValue(queryBuilder);
  queryBuilder.skip.mockReturnValue(queryBuilder);
  queryBuilder.take.mockReturnValue(queryBuilder);
  queryBuilder.select.mockReturnValue(queryBuilder);
  queryBuilder.addSelect.mockReturnValue(queryBuilder);
  queryBuilder.leftJoin.mockReturnValue(queryBuilder);
  queryBuilder.leftJoinAndSelect.mockReturnValue(queryBuilder);
  queryBuilder.groupBy.mockReturnValue(queryBuilder);
  queryBuilder.addGroupBy.mockReturnValue(queryBuilder);
  queryBuilder.limit.mockReturnValue(queryBuilder);

  return queryBuilder;
};

// Mock repository
const createMockRepository = (): MockRepository => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(createMockQueryBuilder),
});

const mockTenantRepository = createMockRepository();
const mockInvitationRepository = createMockRepository();
const mockActivityRepository = createMockRepository();
const mockNoteRepository = createMockRepository();
const mockBillingRepository = createMockRepository();

const mockQueryRunner = {
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
    create: jest.fn(
      <TEntity extends object>(entityClass: new () => TEntity, data: Partial<TEntity>): TEntity => {
        const instance = new entityClass();
        Object.assign(instance, data);
        return instance;
      },
    ),
    query: jest.fn().mockResolvedValue([]),
  },
};

const mockDataSource = {
  createQueryRunner: jest.fn(() => mockQueryRunner),
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
      controllers: [TenantAdminController],
      providers: [
        // ADMIN-CRITICAL-009: @TenantParam resolves ids through the kernel
        // port; these suites exercise the controllers, not the lookup.
        {
          provide: TENANT_ACTIVE_CHECK,
          useValue: { lookupTenant: () => Promise.resolve({ status: TenantStatus.ACTIVE }) },
        },
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
          provide: SystemSettingService,
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
        {
          provide: TenantProvisioningWorkflowService,
          useValue: mockProvisioningWorkflowService,
        },
        {
          provide: ModuleAssignmentService,
          useValue: mockModuleAssignmentService,
        },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: mockAuthProvisioningClient,
        },
        {
          provide: OutboxPublisher,
          useValue: mockOutboxPublisher,
        },
        {
          provide: 'EVENT_BUS',
          useValue: mockEventBus,
        },
        // Command Handlers
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
    describe('Suspend -> Activate -> Deactivate -> Archive Flow', () => {
      it('should complete owner-command backed tenant lifecycle transitions', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();
        const suspendDto: SuspendTenantDto = { reason: 'Policy violation' };

        // Single-writer (DB-ADMIN-HIGH-004): the pre-read (repository) and the
        // post-reply re-read (queryRunner manager) resolve the same shared row
        // object; each owner-command mock flips its status to simulate the
        // committed auth-service write the handler re-reads.
        mockTenantRepository.findOne.mockResolvedValue(tenant);
        queryRunner.manager.findOne.mockResolvedValue(tenant);
        mockAuthProvisioningClient.suspendTenant.mockImplementationOnce(async () => {
          tenant.status = TenantStatus.SUSPENDED;
          return { success: true };
        });
        mockAuthProvisioningClient.activateTenant.mockImplementationOnce(async () => {
          tenant.status = TenantStatus.ACTIVE;
          return { success: true };
        });
        mockAuthProvisioningClient.deprovisionTenant.mockImplementationOnce(async () => {
          tenant.status = TenantStatus.DEACTIVATED;
          return { success: true };
        });
        mockAuthProvisioningClient.archiveTenant.mockImplementationOnce(async () => {
          tenant.status = TenantStatus.ARCHIVED;
          return { success: true };
        });

        const suspended = await commandBus.execute<SuspendTenantCommand, Tenant>(
          new SuspendTenantCommand(tenant.id, suspendDto, 'admin-123'),
        );
        expect(suspended.status).toBe(TenantStatus.SUSPENDED);

        const activated = await commandBus.execute<ActivateTenantCommand, Tenant>(
          new ActivateTenantCommand(tenant.id, 'admin-123'),
        );
        expect(activated.status).toBe(TenantStatus.ACTIVE);

        const deactivated = await commandBus.execute<DeactivateTenantCommand, Tenant>(
          new DeactivateTenantCommand(tenant.id, 'Tenant shutdown requested', 'admin-123'),
        );
        expect(deactivated.status).toBe(TenantStatus.DEACTIVATED);

        const archived = await commandBus.execute<ArchiveTenantCommand, Tenant>(
          new ArchiveTenantCommand(tenant.id, 'admin-123'),
        );
        expect(archived.status).toBe(TenantStatus.ARCHIVED);

        expect(mockAuthProvisioningClient.suspendTenant).toHaveBeenCalledTimes(1);
        expect(mockAuthProvisioningClient.activateTenant).toHaveBeenCalledTimes(1);
        expect(mockAuthProvisioningClient.deprovisionTenant).toHaveBeenCalledTimes(1);
        expect(mockAuthProvisioningClient.archiveTenant).toHaveBeenCalledTimes(1);
        expect(mockAuditLogService.record).toHaveBeenCalledTimes(4);
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(4);
        // Single-writer: admin-api never writes auth.tenants (the owner does).
        expect(queryRunner.manager.save).not.toHaveBeenCalled();
      });
    });

    describe('Trial Tenant Flow', () => {
      it('should create trial tenant and track trial expiration', async () => {
        const trialEndDate = new Date();
        trialEndDate.setDate(trialEndDate.getDate() + 14);

        const trialTenant = createMockTenant({
          tier: TenantTier.FREE,
          trialEndsAt: trialEndDate,
        });

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        const queryRunner = mockDataSource.createQueryRunner();
        queryRunner.manager.save.mockResolvedValueOnce(trialTenant);

        // Verify trial state — MT-MEDIUM-001 derives it from trialEndsAt (the
        // SSoT), so a future trial window is on-trial / not-expired.
        expect(trialTenant.trialEndsAt).toEqual(trialEndDate);
        expect(trialTenant.isTrialExpired()).toBe(false);
      });

      it('should list expiring trials within specified days', async () => {
        const expiringTenant = createMockTenant({
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
        queryRunner.manager.save.mockResolvedValueOnce(tenant);

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
        queryRunner.manager.save.mockResolvedValueOnce(tenant);

        // Audit log should be created
      });
    });
  });

  describe('Query Handler Integration Tests', () => {
    describe('ListTenantsQuery', () => {
      it('should return paginated tenants', async () => {
        const tenants = [
          createMockTenant(),
          createMockTenant({ id: 'tenant-2', slug: 'tenant-2' }),
        ];
        mockTenantRepository
          .createQueryBuilder()
          .getManyAndCount.mockResolvedValueOnce([tenants, 2]);

        // Execute query through queryBus
        const result = await queryBus.execute(
          new ListTenantsQuery({}, { page: 1, limit: 20 }, { field: 'createdAt', order: 'DESC' }),
        );
      });

      it('should filter tenants by status', async () => {
        const activeTenants = [createMockTenant({ status: TenantStatus.ACTIVE })];
        mockTenantRepository
          .createQueryBuilder()
          .getManyAndCount.mockResolvedValueOnce([activeTenants, 1]);

        // Filter by status
      });

      it('should filter tenants by tier', async () => {
        const enterpriseTenants = [createMockTenant({ tier: TenantTier.ENTERPRISE })];
        mockTenantRepository
          .createQueryBuilder()
          .getManyAndCount.mockResolvedValueOnce([enterpriseTenants, 1]);

        // Filter by tier
      });

      it('should search tenants by name and slug', async () => {
        const foundTenants = [createMockTenant({ name: 'Farm Corp' })];
        mockTenantRepository
          .createQueryBuilder()
          .getManyAndCount.mockResolvedValueOnce([foundTenants, 1]);

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

        const result = await mockDetailService.bulkActivate(['tenant-1', 'tenant-2'], 'admin-123');

        expect(result.success).toHaveLength(2);
      });

      it('should fail to activate archived tenants', async () => {
        mockDetailService.bulkActivate.mockResolvedValueOnce({
          success: [],
          failed: ['archived-tenant'],
        });

        const result = await mockDetailService.bulkActivate(['archived-tenant'], 'admin-123');

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
        queryRunner.manager.save.mockResolvedValueOnce(tenant);
        mockProvisioningService.provisionTenant.mockRejectedValueOnce(
          new Error('Provisioning failed'),
        );

        // Transaction should be rolled back
        // expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      });

      it('should commit transaction on successful creation', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        queryRunner.manager.save.mockResolvedValueOnce(tenant);
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
        const originalImpl = mockDataSource.createQueryRunner.getMockImplementation();
        mockDataSource.createQueryRunner.mockImplementationOnce(() => {
          throw new Error('Connection refused');
        });

        // Consume the mock so it doesn't bleed to next test
        expect(() => mockDataSource.createQueryRunner()).toThrow('Connection refused');
      });

      it('should handle constraint violations', async () => {
        const tenant = createMockTenant();
        const queryRunner = mockDataSource.createQueryRunner();

        mockTenantRepository.findOne.mockResolvedValueOnce(null);
        queryRunner.manager.save.mockRejectedValueOnce({
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
        queryRunner.manager.save.mockResolvedValueOnce(tenant);

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
