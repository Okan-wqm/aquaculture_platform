/**
 * Tenant Creation Test Suite
 *
 * Comprehensive tests for tenant creation functionality:
 * 1. Tenant creation with valid data
 * 2. Tenant creation with duplicate slug (should fail)
 * 3. Tenant creation with duplicate domain (should fail)
 * 4. Tenant provisioning (schema creation, roles, config)
 * 5. First admin user creation
 * 6. Contact validation (email, phone format)
 * 7. Country code validation (ISO 3166-1)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { CommandBus, EventBus } from '@nestjs/cqrs';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { Repository, DataSource, QueryRunner, EntityManager } from 'typeorm';
import { CreateTenantHandler } from '../handlers/create-tenant.handler';
import { CreateTenantCommand } from '../commands/tenant.commands';
import { Tenant, TenantStatus, TenantTier, TenantPlan } from '../entities/tenant.entity';
import { TenantProvisioningService, ProvisioningResult } from '../services/tenant-provisioning.service';
import { AuditLogService } from '../../audit/audit.service';
import { ModuleAssignmentService } from '../../modules/tenant-management/services/module-assignment.service';
import { CreateTenantDto, TenantContactDto } from '../dto/tenant.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: uuidv4(),
    name: 'Test Aquaculture Farm',
    slug: 'test-farm',
    description: 'Test tenant description',
    domain: 'test.aquaculture.com',
    status: TenantStatus.PENDING,
    plan: TenantPlan.PROFESSIONAL,
    maxUsers: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return tenant;
};

const createValidTenantData = (overrides: Partial<CreateTenantDto> = {}): CreateTenantDto => ({
  name: 'Test Aquaculture Farm',
  slug: 'test-farm',
  domain: 'test.aquaculture.com',
  tier: TenantTier.PROFESSIONAL,
  primaryContact: {
    name: 'John Doe',
    email: 'john@test.com',
    phone: '+1234567890',
    role: 'Owner',
  },
  billingContact: {
    name: 'Jane Doe',
    email: 'jane@test.com',
    phone: '+0987654321',
    role: 'Finance Manager',
  },
  country: 'US',
  trialDays: 14,
  ...overrides,
});

const createMockProvisioningResult = (
  overrides: Partial<ProvisioningResult> = {},
): ProvisioningResult => ({
  success: true,
  tenantId: 'test-tenant-id',
  steps: [
    { name: 'validate_tenant', status: 'completed', duration: 10 },
    { name: 'create_schema', status: 'completed', duration: 100 },
    { name: 'setup_default_roles', status: 'completed', duration: 50 },
    { name: 'create_default_config', status: 'completed', duration: 30 },
    { name: 'activate_tenant', status: 'completed', duration: 10 },
  ],
  ...overrides,
});

const createMockEntityManager = (): jest.Mocked<EntityManager> =>
  ({
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((entity, data) => ({ ...data })),
    query: jest.fn(),
  }) as unknown as jest.Mocked<EntityManager>;

const createMockQueryRunner = (
  manager: jest.Mocked<EntityManager>,
): jest.Mocked<QueryRunner> =>
  ({
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager,
  }) as unknown as jest.Mocked<QueryRunner>;

// =============================================================================
// Test Suite: Tenant Creation Handler
// =============================================================================

describe('TenantCreation', () => {
  let handler: CreateTenantHandler;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let provisioningService: jest.Mocked<TenantProvisioningService>;
  let dataSource: jest.Mocked<DataSource>;
  let eventBus: jest.Mocked<EventBus>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let moduleAssignmentService: jest.Mocked<ModuleAssignmentService>;
  let mockManager: jest.Mocked<EntityManager>;
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(async () => {
    mockManager = createMockEntityManager();
    mockQueryRunner = createMockQueryRunner(mockManager);

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const mockTenantRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };

    const mockEventBus = {
      publish: jest.fn(),
    };

    const mockAuditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const mockProvisioningService = {
      provisionTenant: jest.fn().mockResolvedValue(createMockProvisioningResult()),
    };

    const mockModuleAssignmentService = {
      assignModulesToTenant: jest.fn().mockResolvedValue({
        success: true,
        assignedModules: [],
        failedModules: [],
        totalMonthlyPrice: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateTenantHandler,
        {
          provide: getRepositoryToken(Tenant),
          useValue: mockTenantRepository,
        },
        {
          provide: getDataSourceToken(),
          useValue: mockDataSource,
        },
        {
          provide: TenantProvisioningService,
          useValue: mockProvisioningService,
        },
        {
          provide: EventBus,
          useValue: mockEventBus,
        },
        {
          provide: AuditLogService,
          useValue: mockAuditLogService,
        },
        {
          provide: ModuleAssignmentService,
          useValue: mockModuleAssignmentService,
        },
      ],
    }).compile();

    handler = module.get<CreateTenantHandler>(CreateTenantHandler);
    tenantRepository = module.get(getRepositoryToken(Tenant));
    dataSource = module.get(getDataSourceToken());
    provisioningService = module.get(TenantProvisioningService);
    eventBus = module.get(EventBus);
    auditLogService = module.get(AuditLogService);
    moduleAssignmentService = module.get(ModuleAssignmentService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 1. Tenant creation with valid data
  // ===========================================================================

  describe('Tenant creation with valid data', () => {
    it('should create a tenant with valid data successfully', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'uuid-123',
        ...validTenantData,
        status: TenantStatus.PENDING,
        createdAt: new Date(),
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.name).toBe(validTenantData.name);
      expect(result.status).toBe(TenantStatus.PENDING);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(provisioningService.provisionTenant).toHaveBeenCalled();
    });

    it('should set trial end date when trialDays is provided', async () => {
      const validTenantData = createValidTenantData({ trialDays: 14 });
      const createdTenant = createMockTenant({
        id: 'uuid-123',
        ...validTenantData,
        status: TenantStatus.PENDING,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result.trialEndsAt).toBeDefined();
      const expectedDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      expect(result.trialEndsAt!.getTime()).toBeCloseTo(expectedDate.getTime(), -4);
    });

    it('should default to STARTER tier if not specified', async () => {
      const dataWithoutTier = createValidTenantData();
      delete (dataWithoutTier as Partial<CreateTenantDto>).tier;

      const createdTenant = createMockTenant({
        id: 'uuid-123',
        ...dataWithoutTier,
        plan: TenantPlan.STARTER,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(dataWithoutTier, 'admin-user-id');
      const result = await handler.execute(command);

      expect(mockManager.create).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({ tier: TenantTier.STARTER }),
      );
    });

    it('should start with PENDING status', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result.status).toBe(TenantStatus.PENDING);
    });

    it('should publish TenantCreated event after successful creation', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'TenantCreated',
          payload: expect.objectContaining({
            tenantId: createdTenant.id,
            slug: createdTenant.slug,
            name: createdTenant.name,
            createdBy: 'admin-user-id',
          }),
        }),
      );
    });

    it('should create audit log entry after successful creation', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(auditLogService.log).toHaveBeenCalledWith({
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: createdTenant.id,
        performedBy: 'admin-user-id',
        details: expect.objectContaining({
          name: createdTenant.name,
          slug: createdTenant.slug,
        }),
      });
    });
  });

  // ===========================================================================
  // 2. Tenant creation with duplicate slug (should fail)
  // ===========================================================================

  describe('Tenant creation with duplicate slug', () => {
    it('should reject duplicate slug with ConflictException', async () => {
      const existingTenant = createMockTenant({ slug: 'test-farm' });
      const validTenantData = createValidTenantData({ slug: 'test-farm' });

      mockManager.findOne.mockResolvedValueOnce(existingTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should include slug value in error message', async () => {
      const existingTenant = createMockTenant({ slug: 'existing-slug' });
      const validTenantData = createValidTenantData({ slug: 'existing-slug' });

      mockManager.findOne.mockResolvedValueOnce(existingTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow(/slug.*already exists/i);
    });

    it('should skip slug check if slug is not provided', async () => {
      const validTenantData = createValidTenantData({ slug: undefined });
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result).toBeDefined();
    });

    it('should release query runner even on duplicate slug failure', async () => {
      const existingTenant = createMockTenant({ slug: 'test-farm' });
      const validTenantData = createValidTenantData({ slug: 'test-farm' });

      mockManager.findOne.mockResolvedValueOnce(existingTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 3. Tenant creation with duplicate domain (should fail)
  // ===========================================================================

  describe('Tenant creation with duplicate domain', () => {
    it('should reject duplicate domain with ConflictException', async () => {
      const existingTenant = createMockTenant({ domain: 'test.aquaculture.com' });
      const validTenantData = createValidTenantData({ domain: 'test.aquaculture.com' });

      mockManager.findOne
        .mockResolvedValueOnce(null) // slug check
        .mockResolvedValueOnce(existingTenant); // domain check

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should include domain value in error message', async () => {
      const existingTenant = createMockTenant({ domain: 'existing.aquaculture.com' });
      const validTenantData = createValidTenantData({ domain: 'existing.aquaculture.com' });

      mockManager.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow(/domain.*already exists/i);
    });

    it('should skip domain check if domain is not provided', async () => {
      const validTenantData = createValidTenantData({ domain: undefined });
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result).toBeDefined();
    });

    it('should check both slug and domain independently', async () => {
      const validTenantData = createValidTenantData({
        slug: 'new-slug',
        domain: 'new.aquaculture.com',
      });
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null); // Both checks pass
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      // Verify findOne was called twice (once for slug, once for domain)
      expect(mockManager.findOne).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // 4. Tenant provisioning (schema creation, roles, config)
  // ===========================================================================

  describe('Tenant provisioning', () => {
    it('should call provisioning service after successful tenant creation', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          createFirstAdmin: true,
          adminEmail: validTenantData.primaryContact?.email,
        }),
      );
    });

    it('should handle provisioning failure gracefully', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);
      provisioningService.provisionTenant.mockResolvedValue(
        createMockProvisioningResult({
          success: false,
          error: 'Schema creation failed',
          steps: [
            { name: 'validate_tenant', status: 'completed', duration: 10 },
            { name: 'create_schema', status: 'failed', error: 'Schema creation failed' },
          ],
        }),
      );

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      // Tenant should still be created even if provisioning fails
      expect(result).toBeDefined();
      expect(result.id).toBe(createdTenant.id);
    });

    it('should publish TenantProvisioningFailed event on provisioning failure', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);
      provisioningService.provisionTenant.mockResolvedValue(
        createMockProvisioningResult({
          success: false,
          error: 'Schema creation failed',
        }),
      );

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'TenantProvisioningFailed',
          payload: expect.objectContaining({
            tenantId: createdTenant.id,
            error: 'Schema creation failed',
          }),
        }),
      );
    });

    it('should pass module IDs for provisioning when provided', async () => {
      const moduleIds = ['module-1', 'module-2', 'module-3'];
      const validTenantData = createValidTenantData({ moduleIds });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          assignModules: moduleIds,
        }),
      );
    });

    it('should handle provisioning exception without failing tenant creation', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);
      provisioningService.provisionTenant.mockRejectedValue(
        new Error('Unexpected provisioning error'),
      );

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result).toBeDefined();
      expect(result.id).toBe(createdTenant.id);
    });
  });

  // ===========================================================================
  // 5. First admin user creation
  // ===========================================================================

  describe('First admin user creation', () => {
    it('should request admin user creation when primaryContact email is provided', async () => {
      const validTenantData = createValidTenantData({
        primaryContact: {
          name: 'John Doe',
          email: 'john@test.com',
          phone: '+1234567890',
          role: 'Owner',
        },
      });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          createFirstAdmin: true,
          adminEmail: 'john@test.com',
          adminFirstName: 'John',
          adminLastName: 'Doe',
        }),
      );
    });

    it('should not request admin creation when primaryContact is not provided', async () => {
      const validTenantData = createValidTenantData({ primaryContact: undefined });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          createFirstAdmin: false,
        }),
      );
    });

    it('should use contactEmail as fallback when primaryContact is not provided', async () => {
      const validTenantData = createValidTenantData({
        primaryContact: undefined,
        contactEmail: 'fallback@test.com',
      });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          createFirstAdmin: true,
          adminEmail: 'fallback@test.com',
        }),
      );
    });

    it('should parse multi-word names correctly', async () => {
      const validTenantData = createValidTenantData({
        primaryContact: {
          name: 'John Robert Doe Smith',
          email: 'john@test.com',
          role: 'Owner',
        },
      });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          adminFirstName: 'John',
          adminLastName: 'Robert Doe Smith',
        }),
      );
    });

    it('should default lastName to "User" for single-name contacts', async () => {
      const validTenantData = createValidTenantData({
        primaryContact: {
          name: 'Admin',
          email: 'admin@test.com',
          role: 'Owner',
        },
      });
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        createdTenant.id,
        expect.objectContaining({
          adminFirstName: 'Admin',
          adminLastName: 'User',
        }),
      );
    });

    it('should include admin user info in successful provisioning result', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({
        id: 'new-tenant-id',
        ...validTenantData,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);
      provisioningService.provisionTenant.mockResolvedValue(
        createMockProvisioningResult({
          adminUser: {
            userId: 'admin-user-uuid',
            email: 'john@test.com',
            invitationToken: 'invitation-token-123',
          },
        }),
      );

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      const result = await handler.execute(command);

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // Transaction behavior tests
  // ===========================================================================

  describe('Transaction behavior', () => {
    it('should use SERIALIZABLE isolation level', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    });

    it('should use pessimistic_read lock for duplicate checks', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(mockManager.findOne).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({
          lock: { mode: 'pessimistic_read' },
        }),
      );
    });

    it('should rollback transaction on database error', async () => {
      const validTenantData = createValidTenantData();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow('Database error');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should always release query runner', async () => {
      const validTenantData = createValidTenantData();
      const createdTenant = createMockTenant({ ...validTenantData });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.create.mockReturnValue(createdTenant);
      mockManager.save.mockResolvedValue(createdTenant);

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');
      await handler.execute(command);

      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should release query runner even on error', async () => {
      const validTenantData = createValidTenantData();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(validTenantData, 'admin-user-id');

      await expect(handler.execute(command)).rejects.toThrow();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Test Suite: Contact Validation
// =============================================================================

describe('TenantContactValidation', () => {
  describe('primaryContact email validation', () => {
    it('should accept valid email formats', async () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.org',
        'user+tag@company.co.uk',
        'firstname.lastname@subdomain.domain.com',
      ];

      for (const email of validEmails) {
        const contact = plainToInstance(TenantContactDto, {
          name: 'Test User',
          email,
          role: 'Admin',
        });
        const errors = await validate(contact);
        const emailErrors = errors.filter((e) => e.property === 'email');
        expect(emailErrors).toHaveLength(0);
      }
    });

    it('should reject invalid email formats', async () => {
      const invalidEmails = [
        'invalid-email',
        '@nodomain.com',
        'missing@.com',
        'spaces in@email.com',
        'double@@email.com',
      ];

      for (const email of invalidEmails) {
        const contact = plainToInstance(TenantContactDto, {
          name: 'Test User',
          email,
          role: 'Admin',
        });
        const errors = await validate(contact);
        const emailErrors = errors.filter((e) => e.property === 'email');
        expect(emailErrors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('primaryContact phone validation', () => {
    it('should accept valid E.164 phone formats', async () => {
      const validPhones = [
        '+1234567890',
        '+12345678901234',
        '+905551234567',
      ];

      for (const phone of validPhones) {
        const contact = plainToInstance(TenantContactDto, {
          name: 'Test User',
          email: 'test@example.com',
          phone,
          role: 'Admin',
        });
        const errors = await validate(contact);
        const phoneErrors = errors.filter((e) => e.property === 'phone');
        expect(phoneErrors).toHaveLength(0);
      }
    });

    it('should accept valid common phone formats', async () => {
      const validPhones = [
        '+44 20 7946 0958',
        '+1-555-123-4567',
        '(555) 123-4567',
        '555.123.4567',
      ];

      for (const phone of validPhones) {
        const contact = plainToInstance(TenantContactDto, {
          name: 'Test User',
          email: 'test@example.com',
          phone,
          role: 'Admin',
        });
        const errors = await validate(contact);
        const phoneErrors = errors.filter((e) => e.property === 'phone');
        expect(phoneErrors).toHaveLength(0);
      }
    });

    it('should allow phone to be optional', async () => {
      const contact = plainToInstance(TenantContactDto, {
        name: 'Test User',
        email: 'test@example.com',
        role: 'Admin',
      });
      const errors = await validate(contact);
      const phoneErrors = errors.filter((e) => e.property === 'phone');
      expect(phoneErrors).toHaveLength(0);
    });
  });

  describe('contact name validation', () => {
    it('should require minimum 2 characters for name', async () => {
      const contact = plainToInstance(TenantContactDto, {
        name: 'A',
        email: 'test@example.com',
        role: 'Admin',
      });
      const errors = await validate(contact);
      const nameErrors = errors.filter((e) => e.property === 'name');
      expect(nameErrors.length).toBeGreaterThan(0);
    });

    it('should accept valid names', async () => {
      const validNames = ['Jo', 'John', 'John Doe', 'John Robert Doe-Smith'];

      for (const name of validNames) {
        const contact = plainToInstance(TenantContactDto, {
          name,
          email: 'test@example.com',
          role: 'Admin',
        });
        const errors = await validate(contact);
        const nameErrors = errors.filter((e) => e.property === 'name');
        expect(nameErrors).toHaveLength(0);
      }
    });

    it('should reject names exceeding 100 characters', async () => {
      const longName = 'A'.repeat(101);
      const contact = plainToInstance(TenantContactDto, {
        name: longName,
        email: 'test@example.com',
        role: 'Admin',
      });
      const errors = await validate(contact);
      const nameErrors = errors.filter((e) => e.property === 'name');
      expect(nameErrors.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Test Suite: Country Code Validation
// =============================================================================

describe('CountryCodeValidation', () => {
  describe('ISO 3166-1 alpha-2 country codes', () => {
    it('should accept valid ISO 3166-1 alpha-2 codes', async () => {
      const validCodes = ['US', 'GB', 'DE', 'JP', 'AU', 'TR', 'FR', 'CA', 'BR', 'IN'];

      for (const country of validCodes) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          country,
        });
        const errors = await validate(dto);
        const countryErrors = errors.filter((e) => e.property === 'country');
        expect(countryErrors).toHaveLength(0);
      }
    });

    it('should reject 3-letter country codes (ISO 3166-1 alpha-3)', async () => {
      const invalidCodes = ['USA', 'GBR', 'DEU', 'JPN', 'AUS'];

      for (const country of invalidCodes) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          country,
        });
        const errors = await validate(dto);
        const countryErrors = errors.filter((e) => e.property === 'country');
        expect(countryErrors.length).toBeGreaterThan(0);
      }
    });

    it('should reject lowercase country codes', async () => {
      const invalidCodes = ['us', 'gb', 'de'];

      for (const country of invalidCodes) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          country,
        });
        const errors = await validate(dto);
        const countryErrors = errors.filter((e) => e.property === 'country');
        expect(countryErrors.length).toBeGreaterThan(0);
      }
    });

    it('should reject numeric country codes', async () => {
      const invalidCodes = ['12', '840', '1'];

      for (const country of invalidCodes) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          country,
        });
        const errors = await validate(dto);
        const countryErrors = errors.filter((e) => e.property === 'country');
        expect(countryErrors.length).toBeGreaterThan(0);
      }
    });

    it('should reject single letter codes', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        country: 'A',
      });
      const errors = await validate(dto);
      const countryErrors = errors.filter((e) => e.property === 'country');
      expect(countryErrors.length).toBeGreaterThan(0);
    });

    it('should transform lowercase to uppercase', () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        country: 'us',
      });
      // The transform should uppercase the value before validation
      // Note: This tests the transformer behavior
      expect(dto.country).toBe('US');
    });

    it('should allow country to be optional', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
      });
      const errors = await validate(dto);
      const countryErrors = errors.filter((e) => e.property === 'country');
      expect(countryErrors).toHaveLength(0);
    });
  });
});

// =============================================================================
// Test Suite: Slug and Domain Validation
// =============================================================================

describe('SlugAndDomainValidation', () => {
  describe('slug validation', () => {
    it('should accept valid slugs', async () => {
      const validSlugs = [
        'test-farm',
        'my-aquaculture-facility',
        'farm123',
        'a1b2c3',
      ];

      for (const slug of validSlugs) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          slug,
        });
        const errors = await validate(dto);
        const slugErrors = errors.filter((e) => e.property === 'slug');
        expect(slugErrors).toHaveLength(0);
      }
    });

    it('should reject slugs starting with hyphen', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        slug: '-invalid-slug',
      });
      const errors = await validate(dto);
      const slugErrors = errors.filter((e) => e.property === 'slug');
      expect(slugErrors.length).toBeGreaterThan(0);
    });

    it('should reject slugs ending with hyphen', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        slug: 'invalid-slug-',
      });
      const errors = await validate(dto);
      const slugErrors = errors.filter((e) => e.property === 'slug');
      expect(slugErrors.length).toBeGreaterThan(0);
    });

    it('should reject uppercase slugs', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        slug: 'Invalid-Slug',
      });
      const errors = await validate(dto);
      const slugErrors = errors.filter((e) => e.property === 'slug');
      expect(slugErrors.length).toBeGreaterThan(0);
    });

    it('should reject slugs with special characters', async () => {
      const invalidSlugs = ['test_farm', 'test.farm', 'test@farm', 'test farm'];

      for (const slug of invalidSlugs) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          slug,
        });
        const errors = await validate(dto);
        const slugErrors = errors.filter((e) => e.property === 'slug');
        expect(slugErrors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('domain validation', () => {
    it('should accept valid domains', async () => {
      const validDomains = [
        'test.aquaculture.com',
        'my-farm.example.org',
        'subdomain.domain.co.uk',
        'a.b.c',
      ];

      for (const domain of validDomains) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          domain,
        });
        const errors = await validate(dto);
        const domainErrors = errors.filter((e) => e.property === 'domain');
        expect(domainErrors).toHaveLength(0);
      }
    });

    it('should reject domains starting with hyphen', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        domain: '-invalid.com',
      });
      const errors = await validate(dto);
      const domainErrors = errors.filter((e) => e.property === 'domain');
      expect(domainErrors.length).toBeGreaterThan(0);
    });

    it('should reject domains with uppercase letters', async () => {
      const dto = plainToInstance(CreateTenantDto, {
        name: 'Test Tenant',
        domain: 'Invalid.COM',
      });
      const errors = await validate(dto);
      const domainErrors = errors.filter((e) => e.property === 'domain');
      expect(domainErrors.length).toBeGreaterThan(0);
    });

    it('should reject domains with invalid characters', async () => {
      const invalidDomains = [
        'test_domain.com',
        'test domain.com',
        'test@domain.com',
      ];

      for (const domain of invalidDomains) {
        const dto = plainToInstance(CreateTenantDto, {
          name: 'Test Tenant',
          domain,
        });
        const errors = await validate(dto);
        const domainErrors = errors.filter((e) => e.property === 'domain');
        expect(domainErrors.length).toBeGreaterThan(0);
      }
    });
  });
});
