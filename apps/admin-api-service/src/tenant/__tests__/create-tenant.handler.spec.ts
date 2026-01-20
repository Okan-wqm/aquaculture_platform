/**
 * CreateTenantHandler Test Suite
 *
 * Kapsamlı test senaryoları:
 * - Temel Oluşturma İşlemleri
 * - Validasyon Testleri
 * - Transaction & Rollback
 * - Event Publishing
 * - Audit Logging
 * - Auto-Provisioning
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner, EntityManager } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { CreateTenantHandler } from '../handlers/create-tenant.handler';
import { CreateTenantCommand } from '../commands/tenant.commands';
import { Tenant, TenantStatus, TenantTier } from '../entities/tenant.entity';
import { AuditLogService } from '../../audit/audit.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { CreateTenantDto } from '../dto/tenant.dto';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: uuidv4(),
    name: 'Test Tenant',
    slug: 'test-tenant',
    description: 'Test tenant description',
    domain: 'test.example.com',
    status: TenantStatus.PENDING,
    tier: TenantTier.FREE,
    userCount: 0,
    farmCount: 0,
    sensorCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 1,
    ...overrides,
  });
  return tenant;
};

const createMockCreateTenantDto = (overrides: Partial<CreateTenantDto> = {}): CreateTenantDto => ({
  name: 'New Test Tenant',
  slug: 'new-test-tenant',
  description: 'A new test tenant',
  domain: 'newtest.example.com',
  tier: TenantTier.STARTER,
  primaryContact: {
    name: 'Test Admin',
    email: 'admin@test.com',
    phone: '+1234567890',
    role: 'admin',
  },
  billingEmail: 'billing@test.com',
  country: 'Turkey',
  region: 'Istanbul',
  trialDays: 14,
  ...overrides,
});

const createMockEntityManager = (): jest.Mocked<EntityManager> =>
  ({
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((entity, data) => ({ ...data })),
    query: jest.fn(),
  }) as any;

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
  }) as any;

// =============================================================================
// Test Suite
// =============================================================================

describe('CreateTenantHandler', () => {
  let handler: CreateTenantHandler;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let dataSource: jest.Mocked<DataSource>;
  let eventBus: jest.Mocked<EventBus>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let provisioningService: jest.Mocked<TenantProvisioningService>;
  let mockManager: jest.Mocked<EntityManager>;
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(async () => {
    mockManager = createMockEntityManager();
    mockQueryRunner = createMockQueryRunner(mockManager);

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const mockTenantRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    const mockEventBus = {
      publish: jest.fn(),
    };

    const mockAuditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const mockProvisioningService = {
      provisionTenant: jest.fn().mockResolvedValue({ success: true }),
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
          provide: EventBus,
          useValue: mockEventBus,
        },
        {
          provide: AuditLogService,
          useValue: mockAuditLogService,
        },
        {
          provide: TenantProvisioningService,
          useValue: mockProvisioningService,
        },
      ],
    }).compile();

    handler = module.get<CreateTenantHandler>(CreateTenantHandler);
    tenantRepository = module.get(getRepositoryToken(Tenant));
    dataSource = module.get(getDataSourceToken());
    eventBus = module.get(EventBus);
    auditLogService = module.get(AuditLogService);
    provisioningService = module.get(TenantProvisioningService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // TEMEL OLUŞTURMA İŞLEMLERİ
  // ===========================================================================

  describe('Temel Oluşturma İşlemleri', () => {
    it('geçerli veri ile tenant başarıyla oluşturulur', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({
        ...dto,
        id: 'new-tenant-id',
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBe(savedTenant.id);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('tenant oluşturma sonrası otomatik ID atanır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto, id: 'generated-uuid' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.id).toBe('generated-uuid');
    });

    it('tenant status PENDING olarak başlar', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({
        ...dto,
        status: TenantStatus.PENDING,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result.status).toBe(TenantStatus.PENDING);
    });

    it('tier belirtilmezse FREE olarak atanır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ tier: undefined });
      const savedTenant = createMockTenant({ ...dto, tier: TenantTier.FREE });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(mockManager.create).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({ tier: TenantTier.FREE }),
      );
    });

    it('trial tenant için trialEndsAt hesaplanır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ trialDays: 14 });
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          trialEndsAt: expect.any(Date),
        }),
      );
    });

    it('trialDays 0 veya undefined ise trialEndsAt ayarlanmaz', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ trialDays: 0 });
      const savedTenant = createMockTenant({ ...dto, trialEndsAt: undefined });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ trialEndsAt: expect.any(Date) }),
      );
    });

    it('userCount, farmCount, sensorCount 0 olarak başlar', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({
        ...dto,
        userCount: 0,
        farmCount: 0,
        sensorCount: 0,
      });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.create).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({
          userCount: 0,
          farmCount: 0,
          sensorCount: 0,
        }),
      );
    });
  });

  // ===========================================================================
  // DUPLICATE KONTROL TESTLERİ
  // ===========================================================================

  describe('Duplicate Kontrol Testleri', () => {
    it('duplicate slug reddedilir', async () => {
      // Arrange
      const existingTenant = createMockTenant({ slug: 'existing-slug' });
      const dto = createMockCreateTenantDto({ slug: 'existing-slug' });

      mockManager.findOne
        .mockResolvedValueOnce(existingTenant) // slug check
        .mockResolvedValueOnce(null); // domain check

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/slug.*already exists/i);
    });

    it('duplicate domain reddedilir', async () => {
      // Arrange
      const existingTenant = createMockTenant({ domain: 'existing.example.com' });
      const dto = createMockCreateTenantDto({ domain: 'existing.example.com' });

      mockManager.findOne
        .mockResolvedValueOnce(null) // slug check
        .mockResolvedValueOnce(existingTenant); // domain check

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow(ConflictException);
      await expect(handler.execute(command)).rejects.toThrow(/domain.*already exists/i);
    });

    it('slug sağlanmazsa duplicate check yapılmaz', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ slug: undefined });
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      // findOne should only be called once for domain check (if domain provided)
      // Since we didn't provide slug, the slug findOne should be skipped
    });

    it('domain sağlanmazsa duplicate check yapılmaz', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ domain: undefined });
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      // Domain check should be skipped
    });
  });

  // ===========================================================================
  // TRANSACTION TESTLERİ
  // ===========================================================================

  describe('Transaction Testleri', () => {
    it('transaction SERIALIZABLE isolation level ile başlar', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    });

    it('başarılı işlemde transaction commit edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('hata durumunda transaction rollback edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow('Database error');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('QueryRunner her zaman release edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('hata durumunda da QueryRunner release edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('pessimistic_read lock kullanılır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.findOne).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({
          lock: { mode: 'pessimistic_read' },
        }),
      );
    });
  });

  // ===========================================================================
  // EVENT PUBLISHING TESTLERİ
  // ===========================================================================

  describe('Event Publishing Testleri', () => {
    it('tenant oluşturulduktan sonra TenantCreated event publish edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'TenantCreated',
          payload: expect.objectContaining({
            tenantId: savedTenant.id,
            slug: savedTenant.slug,
            name: savedTenant.name,
            tier: savedTenant.tier,
            createdBy: 'admin-user-id',
          }),
          timestamp: expect.any(Date),
        }),
      );
    });

    it('hata durumunda event publish edilmez', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // AUDIT LOGGING TESTLERİ
  // ===========================================================================

  describe('Audit Logging Testleri', () => {
    it('tenant oluşturulduktan sonra audit log kaydedilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(auditLogService.log).toHaveBeenCalledWith({
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: savedTenant.id,
        performedBy: 'admin-user-id',
        details: expect.objectContaining({
          name: savedTenant.name,
          slug: savedTenant.slug,
          tier: savedTenant.tier,
        }),
      });
    });

    it('hata durumunda audit log kaydedilmez', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockRejectedValue(new Error('Database error'));

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act & Assert
      await expect(handler.execute(command)).rejects.toThrow();
      expect(auditLogService.log).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // AUTO-PROVISIONING TESTLERİ
  // ===========================================================================

  describe('Auto-Provisioning Testleri', () => {
    it('primaryContact email varsa auto-provisioning tetiklenir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        primaryContact: {
          name: 'Test Admin',
          email: 'admin@test.com',
          phone: '+1234567890',
          role: 'admin',
        },
      });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert - setImmediate içinde çağrıldığından async olarak kontrol etmeliyiz
      // Bu test için manuel olarak promise'ı bekletebiliriz
      await new Promise((resolve) => setImmediate(resolve));

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        savedTenant.id,
        expect.objectContaining({
          createFirstAdmin: true,
          adminEmail: 'admin@test.com',
          adminFirstName: 'Test',
          adminLastName: 'Admin',
        }),
      );
    });

    it('primaryContact yoksa auto-provisioning tetiklenmez', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({ primaryContact: undefined });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      await new Promise((resolve) => setImmediate(resolve));
      expect(provisioningService.provisionTenant).not.toHaveBeenCalled();
    });

    it('primaryContact email boşsa auto-provisioning tetiklenmez', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        primaryContact: {
          name: 'Test Admin',
          email: '',
          phone: '+1234567890',
          role: 'admin',
        },
      });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      await new Promise((resolve) => setImmediate(resolve));
      expect(provisioningService.provisionTenant).not.toHaveBeenCalled();
    });

    it('auto-provisioning hatası tenant oluşturmayı etkilemez', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        primaryContact: {
          name: 'Test Admin',
          email: 'admin@test.com',
          phone: '+1234567890',
          role: 'admin',
        },
      });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);
      provisioningService.provisionTenant.mockRejectedValue(new Error('Provisioning failed'));

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      const result = await handler.execute(command);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBe(savedTenant.id);
    });

    it('admin ismi doğru şekilde parse edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        primaryContact: {
          name: 'John Doe Smith',
          email: 'john@test.com',
          phone: '+1234567890',
          role: 'admin',
        },
      });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      await new Promise((resolve) => setImmediate(resolve));

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        savedTenant.id,
        expect.objectContaining({
          adminFirstName: 'John',
          adminLastName: 'Doe Smith',
        }),
      );
    });

    it('tek isimli contact için lastName "User" olarak atanır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        primaryContact: {
          name: 'Admin',
          email: 'admin@test.com',
          phone: '+1234567890',
          role: 'admin',
        },
      });
      const savedTenant = createMockTenant({ ...dto, id: 'new-tenant-id' });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      await new Promise((resolve) => setImmediate(resolve));

      expect(provisioningService.provisionTenant).toHaveBeenCalledWith(
        savedTenant.id,
        expect.objectContaining({
          adminFirstName: 'Admin',
          adminLastName: 'User',
        }),
      );
    });
  });

  // ===========================================================================
  // DATA MAPPING TESTLERİ
  // ===========================================================================

  describe('Data Mapping Testleri', () => {
    it('tüm DTO alanları tenant entity\'sine doğru şekilde map edilir', async () => {
      // Arrange
      const dto = createMockCreateTenantDto({
        name: 'Complete Tenant',
        slug: 'complete-tenant',
        description: 'Full description',
        domain: 'complete.example.com',
        tier: TenantTier.PROFESSIONAL,
        primaryContact: {
          name: 'Primary',
          email: 'primary@test.com',
          phone: '+1111111111',
          role: 'admin',
        },
        billingContact: {
          name: 'Billing',
          email: 'billing@test.com',
          phone: '+2222222222',
          role: 'billing',
        },
        billingEmail: 'finance@test.com',
        country: 'USA',
        region: 'California',
        trialDays: 30,
      });
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'admin-user-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.create).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          domain: dto.domain,
          tier: dto.tier,
          primaryContact: dto.primaryContact,
          billingContact: dto.billingContact,
          billingEmail: dto.billingEmail,
          country: dto.country,
          region: dto.region,
        }),
      );
    });

    it('createdBy doğru şekilde atanır', async () => {
      // Arrange
      const dto = createMockCreateTenantDto();
      const savedTenant = createMockTenant({ ...dto });

      mockManager.findOne.mockResolvedValue(null);
      mockManager.save.mockResolvedValue(savedTenant);

      const command = new CreateTenantCommand(dto, 'specific-admin-id');

      // Act
      await handler.execute(command);

      // Assert
      expect(mockManager.create).toHaveBeenCalledWith(
        Tenant,
        expect.objectContaining({
          createdBy: 'specific-admin-id',
        }),
      );
    });
  });
});
