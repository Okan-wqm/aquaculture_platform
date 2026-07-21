import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AUTH_ADMIN_COMMAND_SUBJECTS, type AuthModuleSnapshot } from '@platform/event-contracts';
import { of, throwError } from 'rxjs';
import { DataSource } from 'typeorm';

import { AuthTenantProvisioningClientService } from '../../tenant/services/auth-tenant-provisioning-client.service';
import { ModulesService, ModuleDto, TenantModuleAssignment } from '../modules.service';

// Mock DataSource
const mockDataSource = {
  query: jest.fn(),
};

const mockAuthProvisioningClient = {
  assignTenantModules: jest.fn(),
  removeTenantModule: jest.fn(),
};

const mockAuthNatsClient = {
  send: jest.fn(),
};

// Helper to create mock module data
const createMockModule = (overrides: Partial<ModuleDto> = {}): ModuleDto => ({
  id: 'module-uuid-123',
  code: 'FARM_MANAGEMENT',
  name: 'Farm Management',
  description: 'Farm management module',
  defaultRoute: '/farm',
  icon: 'farm-icon',
  isCore: false,
  isActive: true,
  price: 100,
  tenantsCount: 5,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  ...overrides,
});

const createMockModuleSnapshot = (
  overrides: Partial<ModuleDto> = {},
): AuthModuleSnapshot => {
  const module = createMockModule(overrides);
  // WHY price is stripped too: AuthModuleSnapshot carries catalogue metadata
  // only — pricing is billing-owned (D14); ModuleDto.price is derived from
  // the admin.module_pricing catalog on the read side, never from auth.
  const { tenantsCount: _tenantsCount, price: _price, ...snapshot } = module;
  return {
    ...snapshot,
    createdAt: module.createdAt.toISOString(),
    updatedAt: module.updatedAt.toISOString(),
  };
};

// Helper to create mock tenant module assignment
const createMockAssignment = (overrides: Partial<TenantModuleAssignment> = {}): TenantModuleAssignment => ({
  id: 'assignment-uuid-123',
  tenantId: 'tenant-uuid-123',
  tenantName: 'Test Tenant',
  moduleId: 'module-uuid-123',
  moduleCode: 'FARM_MANAGEMENT',
  moduleName: 'Farm Management',
  assignedAt: new Date('2025-01-01'),
  expiresAt: null,
  ...overrides,
});

describe('ModulesService', () => {
  let service: ModulesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDataSource.query.mockReset();
    mockAuthNatsClient.send.mockReset();
    mockAuthProvisioningClient.assignTenantModules.mockResolvedValue({
      success: true,
      modulesAssigned: 1,
    });
    mockAuthProvisioningClient.removeTenantModule.mockResolvedValue({
      success: true,
      modulesRemoved: 1,
    });
    mockAuthNatsClient.send.mockReturnValue(of({
      success: true,
      module: createMockModuleSnapshot({ tenantsCount: 0 }),
      moduleId: 'module-id',
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModulesService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: AuthTenantProvisioningClientService,
          useValue: mockAuthProvisioningClient,
        },
        {
          provide: 'AUTH_NATS_CLIENT',
          useValue: mockAuthNatsClient,
        },
      ],
    }).compile();

    service = module.get<ModulesService>(ModulesService);
  });

  describe('listModules', () => {
    it('should list modules with default pagination', async () => {
      const mockModules = [createMockModule(), createMockModule({ id: 'module-2', code: 'DASHBOARD' })];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules) // modules query
        .mockResolvedValueOnce([{ total: '2' }]); // count query

      const result = await service.listModules({});

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.totalPages).toBe(1);
    });

    it('should filter modules by isActive', async () => {
      const mockModules = [createMockModule({ isActive: true })];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.listModules({ isActive: true });

      expect(result.items).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('m."isActive" = $'),
        expect.arrayContaining([true]),
      );
    });

    it('should filter modules by isCore', async () => {
      const mockModules = [createMockModule({ isCore: true })];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.listModules({ isCore: true });

      expect(result.items).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('is_core'),
        expect.arrayContaining([true]),
      );
    });

    it('should search modules by name, code, or description', async () => {
      const mockModules = [createMockModule()];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.listModules({ search: 'farm' });

      expect(result.items).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%farm%']),
      );
    });

    it('should handle pagination correctly', async () => {
      const mockModules = [createMockModule()];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules)
        .mockResolvedValueOnce([{ total: '100' }]);

      const result = await service.listModules({}, 2, 10);

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(10);
      // Offset should be (page - 1) * limit = 10
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([10, 10]),
      );
    });

    it('should handle empty results', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);

      const result = await service.listModules({});

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      // createStandardPaginatedResult floors totalPages at 1 (canonical SSoT).
      expect(result.totalPages).toBe(1);
    });

    it('should combine multiple filters', async () => {
      const mockModules = [createMockModule()];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules)
        .mockResolvedValueOnce([{ total: '1' }]);

      await service.listModules({ isActive: true, isCore: false, search: 'test' });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE'),
        expect.arrayContaining([true, false, '%test%']),
      );
    });

    it('should throw error on database failure', async () => {
      mockDataSource.query.mockRejectedValueOnce(new Error('DB connection failed'));

      await expect(service.listModules({})).rejects.toThrow('DB connection failed');
    });
  });

  describe('getModuleStats', () => {
    it('should return correct module statistics', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ count: '10' }]) // total modules
        .mockResolvedValueOnce([{ count: '8' }]) // active modules
        .mockResolvedValueOnce([{ count: '3' }]) // core modules
        .mockResolvedValueOnce([{ count: '25' }]) // total assignments
        .mockResolvedValueOnce([
          { moduleId: 'mod-1', moduleName: 'Farm', tenantsCount: 10 },
          { moduleId: 'mod-2', moduleName: 'Dashboard', tenantsCount: 8 },
        ]);

      const result = await service.getModuleStats();
      const moduleUsageMatcher: unknown = expect.arrayContaining([
        expect.objectContaining({ moduleName: 'Farm', tenantsCount: 10 }),
      ]);

      expect(result).toEqual({
        totalModules: 10,
        activeModules: 8,
        coreModules: 3,
        totalAssignments: 25,
        moduleUsage: moduleUsageMatcher,
      });
    });

    it('should handle zero stats gracefully', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      const result = await service.getModuleStats();

      expect(result.totalModules).toBe(0);
      expect(result.activeModules).toBe(0);
      expect(result.coreModules).toBe(0);
      expect(result.totalAssignments).toBe(0);
      expect(result.moduleUsage).toEqual([]);
    });

    it('should throw error on database failure', async () => {
      mockDataSource.query.mockRejectedValueOnce(new Error('Stats query failed'));

      await expect(service.getModuleStats()).rejects.toThrow('Stats query failed');
    });
  });

  describe('getModuleById', () => {
    it('should return module when found', async () => {
      const mockModule = createMockModule();
      mockDataSource.query.mockResolvedValueOnce([mockModule]);

      const result = await service.getModuleById('module-uuid-123');

      expect(result).toEqual(mockModule);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE m.id = $1'),
        ['module-uuid-123'],
      );
    });

    it('should derive price from the admin.module_pricing catalog, never from auth.modules (D14)', async () => {
      // A5 / DB-IDENT-MEDIUM-003 regression pin: billing owns pricing —
      // ModuleDto.price must come from the module-pricing catalog's
      // base_price metric; auth.modules no longer carries a price column.
      mockDataSource.query.mockResolvedValueOnce([createMockModule()]);

      await service.getModuleById('module-uuid-123');

      const [sql] = mockDataSource.query.mock.calls[0];
      expect(sql).toContain('admin.module_pricing');
      expect(sql).toContain(`metric.value->>'type' = 'base_price'`);
      expect(sql).not.toContain('m.price');
    });

    it('should throw NotFoundException when module not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleById('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException with correct message when module not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleById('non-existent')).rejects.toThrow('Module with ID non-existent not found');
    });

    it('should throw error on database failure', async () => {
      mockDataSource.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(service.getModuleById('module-uuid')).rejects.toThrow('Query failed');
    });
  });

  describe('getModuleByCode', () => {
    it('should return module when found by code', async () => {
      const mockModule = createMockModule();
      mockDataSource.query.mockResolvedValueOnce([mockModule]);

      const result = await service.getModuleByCode('FARM_MANAGEMENT');

      expect(result).toEqual(mockModule);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE m.code = $1'),
        ['FARM_MANAGEMENT'],
      );
    });

    it('should throw NotFoundException when module code not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleByCode('INVALID_CODE')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException with correct message when module code not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleByCode('INVALID_CODE')).rejects.toThrow('Module with code INVALID_CODE not found');
    });
  });

  describe('createModule', () => {
    const createDto = {
      code: 'NEW_MODULE',
      name: 'New Module',
      description: 'A new module',
      defaultRoute: '/new',
      icon: 'new-icon',
      isCore: false,
    };

    it('should create module with all fields and re-read through the catalog-priced SELECT', async () => {
      const mockCreated = createMockModule({ ...createDto, id: 'new-module-id', tenantsCount: 0 });
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: true,
        module: createMockModuleSnapshot(mockCreated),
      }));
      // createModule re-reads via getModuleById so price comes from the
      // admin.module_pricing catalog, never from the auth snapshot.
      mockDataSource.query.mockResolvedValueOnce([mockCreated]);

      const result = await service.createModule(createDto);

      expect(result).toEqual(mockCreated);
      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE,
        expect.objectContaining(createDto),
      );
      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE,
        expect.not.objectContaining({ price: expect.anything() }),
      );
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('admin.module_pricing'),
        ['new-module-id'],
      );
    });

    it('should create module with minimal fields', async () => {
      const minimalDto = {
        code: 'MINIMAL',
        name: 'Minimal Module',
        defaultRoute: '/minimal',
      };
      const mockCreated = createMockModule({ ...minimalDto, id: 'minimal-id' });
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: true,
        module: createMockModuleSnapshot(mockCreated),
      }));
      mockDataSource.query.mockResolvedValueOnce([mockCreated]);

      await service.createModule(minimalDto);

      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE,
        expect.objectContaining({
          code: 'MINIMAL',
          name: 'Minimal Module',
          description: null,
          defaultRoute: '/minimal',
          icon: null,
          isCore: false,
        }),
      );
    });

    it('should throw ConflictException on duplicate code', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'DUPLICATE_MODULE',
      }));

      await expect(service.createModule(createDto)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException with correct message on duplicate code', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'DUPLICATE_MODULE',
      }));

      await expect(service.createModule(createDto)).rejects.toThrow(`Module with code ${createDto.code} already exists`);
    });

    it('should throw error on auth-service failures', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(throwError(() => new Error('NATS failed')));

      await expect(service.createModule(createDto)).rejects.toThrow('NATS failed');
    });
  });

  describe('updateModule', () => {
    it('should update module with all fields', async () => {
      const updateDto = {
        name: 'Updated Name',
        description: 'Updated description',
        defaultRoute: '/updated',
        icon: 'updated-icon',
        isActive: false,
      };
      const mockUpdated = createMockModule({ ...updateDto, id: 'module-id' });
      mockDataSource.query
        .mockResolvedValueOnce([mockUpdated]); // getModuleById

      const result = await service.updateModule('module-id', updateDto);

      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        expect.objectContaining({ moduleId: 'module-id', ...updateDto }),
      );
      expect(result.name).toBe('Updated Name');
    });

    it('should update module with partial fields', async () => {
      const updateDto = { name: 'Only Name' };
      const mockUpdated = createMockModule({ ...updateDto, id: 'module-id' });
      mockDataSource.query
        .mockResolvedValueOnce([mockUpdated]);

      await service.updateModule('module-id', updateDto);

      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        expect.objectContaining({ moduleId: 'module-id', name: 'Only Name' }),
      );
    });

    it('should return current module if no updates provided', async () => {
      const mockModule = createMockModule();
      mockDataSource.query.mockResolvedValueOnce([mockModule]);

      const result = await service.updateModule('module-id', {});

      expect(result).toEqual(mockModule);
    });

    it('should throw error on auth-service failure', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(throwError(() => new Error('Update failed')));

      await expect(service.updateModule('module-id', { name: 'Test' })).rejects.toThrow('Update failed');
    });
  });

  describe('setModuleStatus', () => {
    it('should activate module', async () => {
      const mockModule = createMockModule({ isActive: true });
      mockDataSource.query
        .mockResolvedValueOnce([mockModule]);

      const result = await service.setModuleStatus('module-id', true);

      expect(result.isActive).toBe(true);
    });

    it('should deactivate module', async () => {
      const mockModule = createMockModule({ isActive: false });
      mockDataSource.query
        .mockResolvedValueOnce([mockModule]);

      const result = await service.setModuleStatus('module-id', false);

      expect(result.isActive).toBe(false);
    });
  });

  describe('deleteModule', () => {
    it('should delete module with no assignments', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: true,
        moduleId: 'module-id',
      }));

      await expect(service.deleteModule('module-id')).resolves.toBeUndefined();
      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE,
        { moduleId: 'module-id' },
      );
    });

    it('should throw ConflictException when module has assignments', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
      }));

      await expect(service.deleteModule('module-id')).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException with correct message when module has assignments', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
      }));

      await expect(service.deleteModule('module-id')).rejects.toThrow(
        'Cannot delete module that is assigned to tenants',
      );
    });

    it('should throw NotFoundException when module not found', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'MODULE_NOT_FOUND',
      }));

      await expect(service.deleteModule('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error on auth-service failure', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(throwError(() => new Error('Delete failed')));

      await expect(service.deleteModule('module-id')).rejects.toThrow('Delete failed');
    });
  });

  describe('getModuleTenants', () => {
    it('should return tenants assigned to a module', async () => {
      const mockTenants = [
        { id: 'tenant-1', name: 'Tenant 1', slug: 'tenant-1', status: 'ACTIVE', assignedAt: new Date(), expiresAt: null },
        { id: 'tenant-2', name: 'Tenant 2', slug: 'tenant-2', status: 'ACTIVE', assignedAt: new Date(), expiresAt: null },
      ];
      mockDataSource.query
        .mockResolvedValueOnce(mockTenants)
        .mockResolvedValueOnce([{ total: '2' }]);

      const result = await service.getModuleTenants('module-id');

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should handle pagination for module tenants', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'tenant-1', name: 'Tenant 1' }])
        .mockResolvedValueOnce([{ total: '50' }]);

      const result = await service.getModuleTenants('module-id', 2, 10);

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(5);
    });

    it('should return empty array when no tenants assigned', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);

      const result = await service.getModuleTenants('module-id');

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('getAssignments', () => {
    it('should return all assignments without filter', async () => {
      const mockAssignments = [createMockAssignment(), createMockAssignment({ id: 'assign-2' })];
      mockDataSource.query
        .mockResolvedValueOnce(mockAssignments)
        .mockResolvedValueOnce([{ total: '2' }]);

      const result = await service.getAssignments({});

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter assignments by tenantId', async () => {
      const mockAssignments = [createMockAssignment()];
      mockDataSource.query
        .mockResolvedValueOnce(mockAssignments)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.getAssignments({ tenantId: 'tenant-123' });

      expect(result.items).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('tm."tenantId" = $'),
        expect.arrayContaining(['tenant-123']),
      );
    });

    it('should filter assignments by moduleId', async () => {
      const mockAssignments = [createMockAssignment()];
      mockDataSource.query
        .mockResolvedValueOnce(mockAssignments)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.getAssignments({ moduleId: 'module-123' });

      expect(result.items).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('tm."moduleId" = $'),
        expect.arrayContaining(['module-123']),
      );
    });

    it('should filter by both tenantId and moduleId', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([createMockAssignment()])
        .mockResolvedValueOnce([{ total: '1' }]);

      await service.getAssignments({ tenantId: 'tenant-123', moduleId: 'module-123' });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('tm."tenantId" = $'),
        expect.arrayContaining(['tenant-123', 'module-123']),
      );
    });
  });

  describe('assignModuleToTenant', () => {
    const assignDto = {
      tenantId: 'tenant-uuid',
      moduleId: 'module-uuid',
    };

    it('should assign module to tenant', async () => {
      const mockAssignment = createMockAssignment();
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]); // get full details

      const result = await service.assignModuleToTenant(assignDto);
      const operationIdMatcher: unknown = expect.any(String);
      const requestReferenceMatcher: unknown = expect.stringMatching(
        /^AssignModules:tenant-uuid:tenant-uuid:[a-f0-9]{64}$/,
      );

      expect(result).toEqual(mockAssignment);
      expect(mockAuthProvisioningClient.assignTenantModules).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-uuid',
          moduleIds: ['module-uuid'],
          modules: [{ moduleId: 'module-uuid' }],
          assignedBy: 'tenant-uuid',
          operationId: operationIdMatcher,
          requestReference: requestReferenceMatcher,
          actor: { id: 'tenant-uuid', type: 'user' },
          auditMetadata: {
            source: 'admin-api-service',
            commandType: 'AssignModules',
          },
        }),
      );
    });

    it('should assign module with expiration date', async () => {
      // expiresAt is an ISO-8601 string on the wire, forwarded verbatim (APA-067).
      const expiresAt = '2025-12-31T00:00:00.000Z';
      const dtoWithExpiry = { ...assignDto, expiresAt };
      const mockAssignment = createMockAssignment({ expiresAt: new Date(expiresAt) });
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);

      const result = await service.assignModuleToTenant(dtoWithExpiry);

      expect(result.expiresAt).toEqual(new Date(expiresAt));
      expect(mockAuthProvisioningClient.assignTenantModules).toHaveBeenCalledWith(
        expect.objectContaining({
          modules: [expect.objectContaining({ expiresAt })],
        }),
      );
    });

    it('should delegate existing assignment upsert to auth-service', async () => {
      const mockAssignment = createMockAssignment();
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);

      await service.assignModuleToTenant(assignDto);

      expect(mockAuthProvisioningClient.assignTenantModules).toHaveBeenCalledTimes(1);
    });

    it('should throw error on auth-service handoff failure', async () => {
      mockDataSource.query.mockResolvedValueOnce([]); // checkExtendedColumns
      mockAuthProvisioningClient.assignTenantModules.mockRejectedValueOnce(new Error('Assign failed'));

      await expect(service.assignModuleToTenant(assignDto)).rejects.toThrow('Assign failed');
    });
  });

  describe('removeModuleFromTenant', () => {
    it('should remove module from tenant', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-id' }]);
      const operationIdMatcher: unknown = expect.any(String);
      const requestReferenceMatcher: unknown = expect.stringMatching(
        /^RemoveModule:tenant-id:tenant-id:[a-f0-9]{64}$/,
      );

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).resolves.toBeUndefined();
      expect(mockAuthProvisioningClient.removeTenantModule).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-id',
          moduleId: 'module-id',
          removedBy: 'tenant-id',
          operationId: operationIdMatcher,
          requestReference: requestReferenceMatcher,
          actor: { id: 'tenant-id', type: 'user' },
          auditMetadata: {
            source: 'admin-api-service',
            commandType: 'RemoveModule',
          },
        }),
      );
    });

    it('should throw NotFoundException when assignment not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException with correct message when assignment not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(
        'Assignment not found for tenant tenant-id and module module-id',
      );
    });

    it('should throw error on auth-service handoff failure', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-id' }]);
      mockAuthProvisioningClient.removeTenantModule.mockRejectedValueOnce(new Error('Remove failed'));

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow('Remove failed');
    });
  });

  describe('Edge Cases and Concurrent Operations', () => {
    it('should handle concurrent module assignments', async () => {
      const assignments = Array.from({ length: 5 }, (_, i) => ({
        tenantId: `tenant-${i}`,
        moduleId: 'shared-module',
      }));

      // With Promise.all, all checkExtendedColumns fire first, then detail selects
      // So we need to order mocks accordingly:
      // 5 checkExtendedColumns results
      for (let i = 0; i < 5; i++) {
        mockDataSource.query.mockResolvedValueOnce([]); // checkExtendedColumns
      }
      // 5 select results
      for (const dto of assignments) {
        mockDataSource.query.mockResolvedValueOnce([createMockAssignment({ tenantId: dto.tenantId })]);
      }

      const results = await Promise.all(assignments.map(dto => service.assignModuleToTenant(dto)));

      expect(results).toHaveLength(5);
    });

    it('should handle special characters in search', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);

      await service.listModules({ search: "test'OR'1'='1" });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["%test'OR'1'='1%"]),
      );
    });

    it('should handle large pagination values', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '10000' }]);

      const result = await service.listModules({}, 100, 100);

      expect(result.page).toBe(100);
      expect(result.totalPages).toBe(100);
    });

    it('should handle null values in module data', async () => {
      const moduleWithNulls = createMockModule({
        description: null,
        icon: null,
      });
      mockDataSource.query.mockResolvedValueOnce([moduleWithNulls]);

      const result = await service.getModuleById('module-id');

      expect(result.description).toBeNull();
      expect(result.icon).toBeNull();
    });
  });

  describe('Module Dependency Checks', () => {
    it('should allow deleting module with no tenant assignments', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ id: 'module-id' }]);

      await expect(service.deleteModule('module-id')).resolves.toBeUndefined();
    });

    it('should prevent deleting core modules with assignments', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(of({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
      }));

      await expect(service.deleteModule('core-module-id')).rejects.toThrow(ConflictException);
    });
  });

  describe('Assignment Expiration', () => {
    it('should create assignment with future expiration', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const futureIso = futureDate.toISOString();

      const dto = {
        tenantId: 'tenant-id',
        moduleId: 'module-id',
        expiresAt: futureIso,
      };
      const mockAssignment = createMockAssignment({ expiresAt: futureDate });
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);

      const result = await service.assignModuleToTenant(dto);

      expect(result.expiresAt).toEqual(futureDate);
    });

    it('should handle null expiration (permanent assignment)', async () => {
      const dto = {
        tenantId: 'tenant-id',
        moduleId: 'module-id',
      };
      const mockAssignment = createMockAssignment({ expiresAt: null });
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);

      const result = await service.assignModuleToTenant(dto);

      expect(result.expiresAt).toBeNull();
    });
  });
});
