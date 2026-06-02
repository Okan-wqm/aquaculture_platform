import { NotFoundException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AUTH_ADMIN_COMMAND_SUBJECTS } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { AuthCommandClientService } from '../../auth/auth-command-client.service';
import { ModulesService, ModuleDto, ModuleStats, TenantModuleAssignment } from '../modules.service';

// Mock DataSource
const mockDataSource = {
  query: jest.fn(),
};

const mockAuthCommandClient = {
  request: jest.fn(),
  assertSuccess: jest.fn(),
};

const authMutationAssertSuccess = (result: any, fallback?: string): any => {
  if (result.success) return result;

  const message = result.error || fallback || 'Auth command failed';
  switch (result.errorCode) {
    case 'DUPLICATE_CODE':
    case 'MODULE_ASSIGNED':
      throw new ConflictException(message);
    case 'MODULE_NOT_FOUND':
    case 'ASSIGNMENT_NOT_FOUND':
      throw new NotFoundException(message);
    default:
      throw new Error(message);
  }
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

// Helper to create mock tenant module assignment
const createMockAssignment = (
  overrides: Partial<TenantModuleAssignment> = {},
): TenantModuleAssignment => ({
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
    mockAuthCommandClient.request.mockReset();
    mockAuthCommandClient.assertSuccess.mockReset();
    mockAuthCommandClient.assertSuccess.mockImplementation(authMutationAssertSuccess);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModulesService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: AuthCommandClientService,
          useValue: mockAuthCommandClient,
        },
      ],
    }).compile();

    service = module.get<ModulesService>(ModulesService);
  });

  describe('listModules', () => {
    it('should list modules with default pagination', async () => {
      const mockModules = [
        createMockModule(),
        createMockModule({ id: 'module-2', code: 'DASHBOARD' }),
      ];
      mockDataSource.query
        .mockResolvedValueOnce(mockModules) // modules query
        .mockResolvedValueOnce([{ total: '2' }]); // count query

      const result = await service.listModules({});

      expect(result.data).toHaveLength(2);
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

      expect(result.data).toHaveLength(1);
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

      expect(result.data).toHaveLength(1);
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

      expect(result.data).toHaveLength(1);
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
      mockDataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: '0' }]);

      const result = await service.listModules({});

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
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

      expect(result).toEqual({
        totalModules: 10,
        activeModules: 8,
        coreModules: 3,
        totalAssignments: 25,
        moduleUsage: expect.arrayContaining([
          expect.objectContaining({ moduleName: 'Farm', tenantsCount: 10 }),
        ]),
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

    it('should throw NotFoundException when module not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleById('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException with correct message when module not found', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.getModuleById('non-existent')).rejects.toThrow(
        'Module with ID non-existent not found',
      );
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

      await expect(service.getModuleByCode('INVALID_CODE')).rejects.toThrow(
        'Module with code INVALID_CODE not found',
      );
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
      price: 50,
    };

    it('should create module with all fields', async () => {
      const mockCreated = createMockModule({ ...createDto, id: 'new-module-id' });
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockCreated,
      });

      const result = await service.createModule(createDto);

      expect(result).toEqual({ ...mockCreated, tenantsCount: 0 });
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE,
        {
          code: createDto.code,
          name: createDto.name,
          description: createDto.description,
          defaultRoute: createDto.defaultRoute,
          icon: createDto.icon,
          isCore: createDto.isCore,
          price: createDto.price,
        },
      );
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should create module with minimal fields', async () => {
      const minimalDto = {
        code: 'MINIMAL',
        name: 'Minimal Module',
        defaultRoute: '/minimal',
      };
      const mockCreated = createMockModule({ ...minimalDto, id: 'minimal-id' });
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockCreated,
      });

      await service.createModule(minimalDto);

      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE,
        {
          code: 'MINIMAL',
          name: 'Minimal Module',
          description: null,
          defaultRoute: '/minimal',
          icon: null,
          isCore: false,
          price: 0,
        },
      );
    });

    it('should throw ConflictException on duplicate code', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'DUPLICATE_CODE',
        error: `Module with code ${createDto.code} already exists`,
      });

      await expect(service.createModule(createDto)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException with correct message on duplicate code', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'DUPLICATE_CODE',
        error: `Module with code ${createDto.code} already exists`,
      });

      await expect(service.createModule(createDto)).rejects.toThrow(
        `Module with code ${createDto.code} already exists`,
      );
    });

    it('should throw error on auth command failures', async () => {
      mockAuthCommandClient.request.mockRejectedValueOnce(new Error('Create command failed'));

      await expect(service.createModule(createDto)).rejects.toThrow('Create command failed');
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
        price: 200,
      };
      const mockUpdated = createMockModule({ ...updateDto, id: 'module-id' });
      mockDataSource.query.mockResolvedValueOnce([mockUpdated]); // getModuleById
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockUpdated,
      });

      const result = await service.updateModule('module-id', updateDto);

      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        {
          moduleId: 'module-id',
          ...updateDto,
        },
      );
      expect(result.name).toBe('Updated Name');
    });

    it('should update module with partial fields', async () => {
      const updateDto = { name: 'Only Name' };
      const mockUpdated = createMockModule({ ...updateDto, id: 'module-id' });
      mockDataSource.query.mockResolvedValueOnce([mockUpdated]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockUpdated,
      });

      await service.updateModule('module-id', updateDto);

      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        { moduleId: 'module-id', name: 'Only Name' },
      );
    });

    it('should return current module if no updates provided', async () => {
      const mockModule = createMockModule();
      mockDataSource.query.mockResolvedValueOnce([mockModule]);

      const result = await service.updateModule('module-id', {});

      expect(result).toEqual(mockModule);
      expect(mockAuthCommandClient.request).not.toHaveBeenCalled();
    });

    it('should throw error on auth command failure', async () => {
      mockAuthCommandClient.request.mockRejectedValueOnce(new Error('Update command failed'));

      await expect(service.updateModule('module-id', { name: 'Test' })).rejects.toThrow(
        'Update command failed',
      );
    });
  });

  describe('setModuleStatus', () => {
    it('should activate module', async () => {
      const mockModule = createMockModule({ isActive: true });
      mockDataSource.query.mockResolvedValueOnce([mockModule]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockModule,
      });

      const result = await service.setModuleStatus('module-id', true);

      expect(result.isActive).toBe(true);
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        { moduleId: 'module-id', isActive: true },
      );
    });

    it('should deactivate module', async () => {
      const mockModule = createMockModule({ isActive: false });
      mockDataSource.query.mockResolvedValueOnce([mockModule]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        module: mockModule,
      });

      const result = await service.setModuleStatus('module-id', false);

      expect(result.isActive).toBe(false);
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE,
        { moduleId: 'module-id', isActive: false },
      );
    });
  });

  describe('deleteModule', () => {
    it('should delete module via auth-service command boundary', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({ success: true });

      await expect(service.deleteModule('module-id')).resolves.toBeUndefined();
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE,
        { moduleId: 'module-id' },
      );
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when module has assignments', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
        error: 'Cannot delete module that is assigned to tenants',
      });

      await expect(service.deleteModule('module-id')).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException with correct message when module has assignments', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
        error: 'Cannot delete module that is assigned to tenants',
      });

      await expect(service.deleteModule('module-id')).rejects.toThrow(
        'Cannot delete module that is assigned to tenants',
      );
    });

    it('should throw NotFoundException when module not found', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'MODULE_NOT_FOUND',
        error: 'Module with ID non-existent not found',
      });

      await expect(service.deleteModule('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error on auth command failure', async () => {
      mockAuthCommandClient.request.mockRejectedValueOnce(new Error('Delete command failed'));

      await expect(service.deleteModule('module-id')).rejects.toThrow('Delete command failed');
    });
  });

  describe('getModuleTenants', () => {
    it('should return tenants assigned to a module', async () => {
      const mockTenants = [
        {
          id: 'tenant-1',
          name: 'Tenant 1',
          slug: 'tenant-1',
          status: 'ACTIVE',
          assignedAt: new Date(),
          expiresAt: null,
        },
        {
          id: 'tenant-2',
          name: 'Tenant 2',
          slug: 'tenant-2',
          status: 'ACTIVE',
          assignedAt: new Date(),
          expiresAt: null,
        },
      ];
      mockDataSource.query
        .mockResolvedValueOnce(mockTenants)
        .mockResolvedValueOnce([{ total: '2' }]);

      const result = await service.getModuleTenants('module-id');

      expect(result.data).toHaveLength(2);
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
      mockDataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: '0' }]);

      const result = await service.getModuleTenants('module-id');

      expect(result.data).toHaveLength(0);
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

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter assignments by tenantId', async () => {
      const mockAssignments = [createMockAssignment()];
      mockDataSource.query
        .mockResolvedValueOnce(mockAssignments)
        .mockResolvedValueOnce([{ total: '1' }]);

      const result = await service.getAssignments({ tenantId: 'tenant-123' });

      expect(result.data).toHaveLength(1);
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

      expect(result.data).toHaveLength(1);
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
      const mockAssignmentRef = {
        id: 'assignment-id',
        tenantId: 'tenant-uuid',
        moduleId: 'module-uuid',
      };
      const mockAssignment = createMockAssignment();
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]); // get full details
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        assignment: mockAssignmentRef,
      });

      const result = await service.assignModuleToTenant(assignDto);

      expect(result).toEqual(mockAssignment);
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE,
        {
          tenantId: 'tenant-uuid',
          moduleId: 'module-uuid',
          expiresAt: null,
          assignedBy: 'tenant-uuid',
          quantities: null,
          configuration: null,
        },
      );
    });

    it('should assign module with expiration date', async () => {
      const expiresAt = new Date('2025-12-31');
      const dtoWithExpiry = { ...assignDto, expiresAt };
      const mockAssignmentRef = { id: 'assignment-id' };
      const mockAssignment = createMockAssignment({ expiresAt });
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        assignment: mockAssignmentRef,
      });

      const result = await service.assignModuleToTenant(dtoWithExpiry);

      expect(result.expiresAt).toEqual(expiresAt);
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE,
        expect.objectContaining({
          tenantId: 'tenant-uuid',
          moduleId: 'module-uuid',
          expiresAt: expiresAt.toISOString(),
          assignedBy: 'tenant-uuid',
        }),
      );
    });

    it('should update existing assignment (upsert)', async () => {
      const mockAssignmentRef = { id: 'existing-assignment-id' };
      const mockAssignment = createMockAssignment();
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        assignment: mockAssignmentRef,
      });

      await service.assignModuleToTenant(assignDto);

      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE,
        expect.objectContaining({
          tenantId: 'tenant-uuid',
          moduleId: 'module-uuid',
        }),
      );
    });

    it('should throw error on auth command failure', async () => {
      mockDataSource.query.mockResolvedValueOnce([]); // checkExtendedColumns
      mockAuthCommandClient.request.mockRejectedValueOnce(new Error('Assignment command failed'));

      await expect(service.assignModuleToTenant(assignDto)).rejects.toThrow(
        'Assignment command failed',
      );
    });
  });

  describe('removeModuleFromTenant', () => {
    it('should remove module from tenant via auth-service command boundary', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({ success: true });

      await expect(
        service.removeModuleFromTenant('tenant-id', 'module-id'),
      ).resolves.toBeUndefined();
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.REMOVE_TENANT_MODULE,
        { tenantId: 'tenant-id', moduleId: 'module-id' },
      );
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when assignment not found', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'ASSIGNMENT_NOT_FOUND',
        error: 'Assignment not found for tenant tenant-id and module module-id',
      });

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException with correct message when assignment not found', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'ASSIGNMENT_NOT_FOUND',
        error: 'Assignment not found for tenant tenant-id and module module-id',
      });

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(
        'Assignment not found for tenant tenant-id and module module-id',
      );
    });

    it('should throw error on auth command failure', async () => {
      mockAuthCommandClient.request.mockRejectedValueOnce(new Error('Remove command failed'));

      await expect(service.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(
        'Remove command failed',
      );
    });
  });

  describe('Edge Cases and Concurrent Operations', () => {
    it('should handle concurrent module assignments', async () => {
      const assignments = Array.from({ length: 5 }, (_, i) => ({
        tenantId: `tenant-${i}`,
        moduleId: 'shared-module',
      }));

      // With Promise.all, all checkExtendedColumns fire first, then inserts, then selects
      // So we need to order mocks accordingly:
      // 5 checkExtendedColumns results
      for (let i = 0; i < 5; i++) {
        mockDataSource.query.mockResolvedValueOnce([]); // checkExtendedColumns
      }
      for (const dto of assignments) {
        mockAuthCommandClient.request.mockResolvedValueOnce({
          success: true,
          assignment: {
            id: `assignment-${dto.tenantId}`,
            tenantId: dto.tenantId,
            moduleId: dto.moduleId,
          },
        });
        mockDataSource.query.mockResolvedValueOnce([
          createMockAssignment({ tenantId: dto.tenantId }),
        ]);
      }

      const results = await Promise.all(
        assignments.map((dto) => service.assignModuleToTenant(dto)),
      );

      expect(results).toHaveLength(5);
      expect(mockAuthCommandClient.request).toHaveBeenCalledTimes(5);
    });

    it('should handle special characters in search', async () => {
      mockDataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: '0' }]);

      await service.listModules({ search: "test'OR'1'='1" });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["%test'OR'1'='1%"]),
      );
    });

    it('should handle large pagination values', async () => {
      mockDataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: '10000' }]);

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
      mockAuthCommandClient.request.mockResolvedValueOnce({ success: true });

      await expect(service.deleteModule('module-id')).resolves.toBeUndefined();
    });

    it('should prevent deleting core modules with assignments', async () => {
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: false,
        errorCode: 'MODULE_ASSIGNED',
        error: 'Cannot delete module that is assigned to tenants',
      });

      await expect(service.deleteModule('core-module-id')).rejects.toThrow(ConflictException);
    });
  });

  describe('Assignment Expiration', () => {
    it('should create assignment with future expiration', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const dto = {
        tenantId: 'tenant-id',
        moduleId: 'module-id',
        expiresAt: futureDate,
      };
      const mockAssignment = createMockAssignment({ expiresAt: futureDate });
      mockDataSource.query
        .mockResolvedValueOnce([]) // checkExtendedColumns
        .mockResolvedValueOnce([mockAssignment]);
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        assignment: { id: 'assignment-id', tenantId: 'tenant-id', moduleId: 'module-id' },
      });

      const result = await service.assignModuleToTenant(dto);

      expect(result.expiresAt).toEqual(futureDate);
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE,
        expect.objectContaining({ expiresAt: futureDate.toISOString() }),
      );
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
      mockAuthCommandClient.request.mockResolvedValueOnce({
        success: true,
        assignment: { id: 'assignment-id', tenantId: 'tenant-id', moduleId: 'module-id' },
      });

      const result = await service.assignModuleToTenant(dto);

      expect(result.expiresAt).toBeNull();
      expect(mockAuthCommandClient.request).toHaveBeenCalledWith(
        AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE,
        expect.objectContaining({ expiresAt: null }),
      );
    });
  });
});
