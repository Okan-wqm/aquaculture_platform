import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { ModulesController, CreateModuleDto, UpdateModuleDto, AssignModuleDto } from '../modules.controller';
import { ModulesService, ModuleDto, PaginatedModules, ModuleStats, TenantModuleAssignment } from '../modules.service';

// Mock ModulesService
const mockModulesService = {
  listModules: jest.fn(),
  getModuleStats: jest.fn(),
  getModuleById: jest.fn(),
  getModuleByCode: jest.fn(),
  getModuleTenants: jest.fn(),
  createModule: jest.fn(),
  updateModule: jest.fn(),
  setModuleStatus: jest.fn(),
  deleteModule: jest.fn(),
  getAssignments: jest.fn(),
  assignModuleToTenant: jest.fn(),
  removeModuleFromTenant: jest.fn(),
};

// Helper to create mock module
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

// Helper to create paginated response
const createPaginatedModules = (modules: ModuleDto[], total: number = modules.length): PaginatedModules => ({
  data: modules,
  total,
  page: 1,
  limit: 50,
  totalPages: Math.ceil(total / 50),
});

// Helper to create mock assignment
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

describe('ModulesController', () => {
  let controller: ModulesController;
  let service: ModulesService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModulesController],
      providers: [
        {
          provide: ModulesService,
          useValue: mockModulesService,
        },
      ],
    }).compile();

    controller = module.get<ModulesController>(ModulesController);
    service = module.get<ModulesService>(ModulesService);
  });

  describe('listModules', () => {
    it('should return paginated modules', async () => {
      const mockModules = [createMockModule(), createMockModule({ id: 'mod-2', code: 'DASHBOARD' })];
      const mockResult = createPaginatedModules(mockModules);
      mockModulesService.listModules.mockResolvedValueOnce(mockResult);

      const result = await controller.listModules();

      expect(result).toEqual(mockResult);
      expect(service.listModules).toHaveBeenCalledWith({}, 1, 50);
    });

    it('should parse isActive query parameter as boolean', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules('true');
      expect(service.listModules).toHaveBeenCalledWith({ isActive: true }, 1, 50);

      await controller.listModules('false');
      expect(service.listModules).toHaveBeenCalledWith({ isActive: false }, 1, 50);
    });

    it('should parse isCore query parameter as boolean', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules(undefined, 'true');
      expect(service.listModules).toHaveBeenCalledWith({ isCore: true }, 1, 50);
    });

    it('should pass search parameter', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules(undefined, undefined, 'farm');

      expect(service.listModules).toHaveBeenCalledWith({ search: 'farm' }, 1, 50);
    });

    it('should parse pagination parameters', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules(undefined, undefined, undefined, '2', '10');

      expect(service.listModules).toHaveBeenCalledWith({}, 2, 10);
    });

    it('should handle all parameters together', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules('true', 'false', 'test', '3', '25');

      expect(service.listModules).toHaveBeenCalledWith(
        { isActive: true, isCore: false, search: 'test' },
        3,
        25,
      );
    });

    it('should handle undefined isActive/isCore as undefined in filter', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules('invalid');

      expect(service.listModules).toHaveBeenCalledWith({ isActive: undefined }, 1, 50);
    });
  });

  describe('getModuleStats', () => {
    it('should return module statistics', async () => {
      const mockStats: ModuleStats = {
        totalModules: 10,
        activeModules: 8,
        coreModules: 3,
        totalAssignments: 25,
        moduleUsage: [{ moduleId: 'mod-1', moduleName: 'Farm', tenantsCount: 10 }],
      };
      mockModulesService.getModuleStats.mockResolvedValueOnce(mockStats);

      const result = await controller.getModuleStats();

      expect(result).toEqual(mockStats);
      expect(service.getModuleStats).toHaveBeenCalled();
    });
  });

  describe('getAllAssignments', () => {
    it('should return all assignments without filter', async () => {
      const mockAssignments = [createMockAssignment()];
      mockModulesService.getAssignments.mockResolvedValueOnce({
        data: mockAssignments,
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      });

      const result = await controller.getAllAssignments();

      expect(result.data).toEqual(mockAssignments);
      expect(service.getAssignments).toHaveBeenCalledWith({}, 1, 50);
    });

    it('should filter by tenantId', async () => {
      mockModulesService.getAssignments.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });

      await controller.getAllAssignments('tenant-123');

      expect(service.getAssignments).toHaveBeenCalledWith({ tenantId: 'tenant-123' }, 1, 50);
    });

    it('should filter by moduleId', async () => {
      mockModulesService.getAssignments.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });

      await controller.getAllAssignments(undefined, 'module-123');

      expect(service.getAssignments).toHaveBeenCalledWith({ moduleId: 'module-123' }, 1, 50);
    });

    it('should handle pagination parameters', async () => {
      mockModulesService.getAssignments.mockResolvedValueOnce({ data: [], total: 0, page: 2, limit: 10, totalPages: 0 });

      await controller.getAllAssignments(undefined, undefined, '2', '10');

      expect(service.getAssignments).toHaveBeenCalledWith({}, 2, 10);
    });
  });

  describe('getModuleById', () => {
    it('should return module by id', async () => {
      const mockModule = createMockModule();
      mockModulesService.getModuleById.mockResolvedValueOnce(mockModule);

      const result = await controller.getModuleById('module-uuid-123');

      expect(result).toEqual(mockModule);
      expect(service.getModuleById).toHaveBeenCalledWith('module-uuid-123');
    });

    it('should propagate NotFoundException', async () => {
      mockModulesService.getModuleById.mockRejectedValueOnce(new NotFoundException('Module not found'));

      await expect(controller.getModuleById('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getModuleByCode', () => {
    it('should return module by code', async () => {
      const mockModule = createMockModule();
      mockModulesService.getModuleByCode.mockResolvedValueOnce(mockModule);

      const result = await controller.getModuleByCode('FARM_MANAGEMENT');

      expect(result).toEqual(mockModule);
      expect(service.getModuleByCode).toHaveBeenCalledWith('FARM_MANAGEMENT');
    });

    it('should propagate NotFoundException', async () => {
      mockModulesService.getModuleByCode.mockRejectedValueOnce(new NotFoundException('Module not found'));

      await expect(controller.getModuleByCode('INVALID')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getModuleTenants', () => {
    it('should return tenants for a module', async () => {
      const mockTenants = [{ id: 'tenant-1', name: 'Tenant 1' }];
      mockModulesService.getModuleTenants.mockResolvedValueOnce({
        data: mockTenants,
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
      });

      const result = await controller.getModuleTenants('module-id');

      expect(result.data).toEqual(mockTenants);
      expect(service.getModuleTenants).toHaveBeenCalledWith('module-id', 1, 50);
    });

    it('should handle pagination', async () => {
      mockModulesService.getModuleTenants.mockResolvedValueOnce({ data: [], total: 0, page: 2, limit: 10, totalPages: 0 });

      await controller.getModuleTenants('module-id', '2', '10');

      expect(service.getModuleTenants).toHaveBeenCalledWith('module-id', 2, 10);
    });
  });

  describe('createModule', () => {
    const createDto: CreateModuleDto = {
      code: 'NEW_MODULE',
      name: 'New Module',
      description: 'A new module',
      defaultRoute: '/new',
      icon: 'new-icon',
      isCore: false,
      price: 50,
    };

    it('should create module', async () => {
      const mockCreated = createMockModule({ ...createDto, id: 'new-id' });
      mockModulesService.createModule.mockResolvedValueOnce(mockCreated);

      const result = await controller.createModule(createDto);

      expect(result).toEqual(mockCreated);
      expect(service.createModule).toHaveBeenCalledWith(createDto);
    });

    it('should propagate ConflictException on duplicate code', async () => {
      mockModulesService.createModule.mockRejectedValueOnce(new ConflictException('Duplicate code'));

      await expect(controller.createModule(createDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('updateModule', () => {
    const updateDto: UpdateModuleDto = {
      name: 'Updated Name',
      description: 'Updated description',
    };

    it('should update module', async () => {
      const mockUpdated = createMockModule({ ...updateDto });
      mockModulesService.updateModule.mockResolvedValueOnce(mockUpdated);

      const result = await controller.updateModule('module-id', updateDto);

      expect(result).toEqual(mockUpdated);
      expect(service.updateModule).toHaveBeenCalledWith('module-id', updateDto);
    });

    it('should propagate NotFoundException', async () => {
      mockModulesService.updateModule.mockRejectedValueOnce(new NotFoundException('Module not found'));

      await expect(controller.updateModule('non-existent', updateDto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('activateModule', () => {
    it('should activate module', async () => {
      const mockModule = createMockModule({ isActive: true });
      mockModulesService.setModuleStatus.mockResolvedValueOnce(mockModule);

      const result = await controller.activateModule('module-id');

      expect(result.isActive).toBe(true);
      expect(service.setModuleStatus).toHaveBeenCalledWith('module-id', true);
    });
  });

  describe('deactivateModule', () => {
    it('should deactivate module', async () => {
      const mockModule = createMockModule({ isActive: false });
      mockModulesService.setModuleStatus.mockResolvedValueOnce(mockModule);

      const result = await controller.deactivateModule('module-id');

      expect(result.isActive).toBe(false);
      expect(service.setModuleStatus).toHaveBeenCalledWith('module-id', false);
    });
  });

  describe('deleteModule', () => {
    it('should delete module', async () => {
      mockModulesService.deleteModule.mockResolvedValueOnce(undefined);

      await expect(controller.deleteModule('module-id')).resolves.toBeUndefined();
      expect(service.deleteModule).toHaveBeenCalledWith('module-id');
    });

    it('should propagate NotFoundException', async () => {
      mockModulesService.deleteModule.mockRejectedValueOnce(new NotFoundException('Module not found'));

      await expect(controller.deleteModule('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('should propagate ConflictException when module has assignments', async () => {
      mockModulesService.deleteModule.mockRejectedValueOnce(new ConflictException('Has assignments'));

      await expect(controller.deleteModule('module-id')).rejects.toThrow(ConflictException);
    });
  });

  describe('assignModuleToTenant', () => {
    const assignDto: AssignModuleDto = {
      tenantId: 'tenant-uuid',
      moduleId: 'module-uuid',
    };

    it('should assign module to tenant', async () => {
      const mockAssignment = createMockAssignment();
      mockModulesService.assignModuleToTenant.mockResolvedValueOnce(mockAssignment);

      const result = await controller.assignModuleToTenant(assignDto);

      expect(result).toEqual(mockAssignment);
      expect(service.assignModuleToTenant).toHaveBeenCalledWith(assignDto);
    });

    it('should assign with expiration date', async () => {
      const expiresAt = new Date('2025-12-31');
      const dtoWithExpiry = { ...assignDto, expiresAt };
      const mockAssignment = createMockAssignment({ expiresAt });
      mockModulesService.assignModuleToTenant.mockResolvedValueOnce(mockAssignment);

      const result = await controller.assignModuleToTenant(dtoWithExpiry);

      expect(result.expiresAt).toEqual(expiresAt);
      expect(service.assignModuleToTenant).toHaveBeenCalledWith(dtoWithExpiry);
    });
  });

  describe('removeModuleFromTenant', () => {
    it('should remove module from tenant', async () => {
      mockModulesService.removeModuleFromTenant.mockResolvedValueOnce(undefined);

      await expect(controller.removeModuleFromTenant('tenant-id', 'module-id')).resolves.toBeUndefined();
      expect(service.removeModuleFromTenant).toHaveBeenCalledWith('tenant-id', 'module-id');
    });

    it('should propagate NotFoundException when assignment not found', async () => {
      mockModulesService.removeModuleFromTenant.mockRejectedValueOnce(new NotFoundException('Assignment not found'));

      await expect(controller.removeModuleFromTenant('tenant-id', 'module-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('Input Validation Edge Cases', () => {
    it('should handle empty string for optional parameters', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules('', '', '');

      expect(service.listModules).toHaveBeenCalledWith(
        { isActive: undefined, isCore: undefined, search: '' },
        1,
        50,
      );
    });

    it('should handle whitespace in search', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      await controller.listModules(undefined, undefined, '   farm   ');

      expect(service.listModules).toHaveBeenCalledWith(
        { search: '   farm   ' },
        1,
        50,
      );
    });

    it('should handle invalid page/limit values', async () => {
      mockModulesService.listModules.mockResolvedValueOnce(createPaginatedModules([]));

      // NaN should be handled gracefully
      await controller.listModules(undefined, undefined, undefined, 'invalid', 'abc');

      expect(service.listModules).toHaveBeenCalledWith({}, NaN, NaN);
    });
  });
});
