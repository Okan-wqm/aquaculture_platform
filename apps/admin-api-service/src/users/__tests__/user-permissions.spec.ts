import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { UserPermissionsService } from '../services/user-permissions.service';
import {
  UserPermissions,
  PanelPermissions,
  DEFAULT_USER_PERMISSIONS,
  TENANT_ADMIN_PERMISSIONS
} from '../entities/user-permissions.entity';

describe('UserPermissionsService', () => {
  let service: UserPermissionsService;
  let repository: jest.Mocked<Repository<UserPermissions>>;

  const mockUserId = 'user-uuid-123';
  const mockTenantId = 'tenant-uuid-456';
  const mockAdminId = 'admin-uuid-789';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserPermissionsService,
        {
          provide: getRepositoryToken(UserPermissions),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            update: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UserPermissionsService>(UserPermissionsService);
    repository = module.get(getRepositoryToken(UserPermissions));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createDefaultPermissions', () => {
    it('should create permissions with DEFAULT_USER_PERMISSIONS for regular users', async () => {
      const mockPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: DEFAULT_USER_PERMISSIONS,
        grantedBy: mockAdminId,
        isActive: true,
      };

      repository.create.mockReturnValue(mockPermission as UserPermissions);
      repository.save.mockResolvedValue(mockPermission as UserPermissions);

      const result = await service.createDefaultPermissions(
        mockUserId,
        mockTenantId,
        mockAdminId,
        false // isAdmin = false
      );

      expect(repository.create).toHaveBeenCalledWith({
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: DEFAULT_USER_PERMISSIONS,
        grantedBy: mockAdminId,
        isActive: true,
      });
      expect(result.permissions).toEqual(DEFAULT_USER_PERMISSIONS);
    });

    it('should create permissions with TENANT_ADMIN_PERMISSIONS for admins', async () => {
      const mockPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: TENANT_ADMIN_PERMISSIONS,
        grantedBy: mockAdminId,
        isActive: true,
      };

      repository.create.mockReturnValue(mockPermission as UserPermissions);
      repository.save.mockResolvedValue(mockPermission as UserPermissions);

      const result = await service.createDefaultPermissions(
        mockUserId,
        mockTenantId,
        mockAdminId,
        true // isAdmin = true
      );

      expect(result.permissions).toEqual(TENANT_ADMIN_PERMISSIONS);
    });

    it('should set grantedBy to the admin who created the permissions', async () => {
      const mockPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: DEFAULT_USER_PERMISSIONS,
        grantedBy: mockAdminId,
        isActive: true,
      };

      repository.create.mockReturnValue(mockPermission as UserPermissions);
      repository.save.mockResolvedValue(mockPermission as UserPermissions);

      const result = await service.createDefaultPermissions(
        mockUserId,
        mockTenantId,
        mockAdminId,
        false
      );

      expect(result.grantedBy).toBe(mockAdminId);
    });
  });

  describe('getUserPermissions', () => {
    it('should return permissions for active user', async () => {
      const mockPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: DEFAULT_USER_PERMISSIONS,
        isActive: true,
      };

      repository.findOne.mockResolvedValue(mockPermission as UserPermissions);

      const result = await service.getUserPermissions(mockUserId, mockTenantId);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { userId: mockUserId, tenantId: mockTenantId, isActive: true },
      });
      expect(result).toEqual(mockPermission);
    });

    it('should return null for non-existent user', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.getUserPermissions('non-existent', mockTenantId);

      expect(result).toBeNull();
    });
  });

  describe('updatePermissions', () => {
    it('should update permissions successfully', async () => {
      const existingPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: { ...DEFAULT_USER_PERMISSIONS },
        grantedBy: 'old-admin',
        isActive: true,
      };

      const newPermissions: Partial<PanelPermissions> = {
        farms: { view: true, create: true, edit: true, delete: false },
      };

      repository.findOne.mockResolvedValue(existingPermission as UserPermissions);
      repository.save.mockImplementation(async (entity) => entity as UserPermissions);

      const result = await service.updatePermissions(
        mockUserId,
        mockTenantId,
        newPermissions,
        mockAdminId
      );

      expect(result.permissions.farms.create).toBe(true);
      expect(result.permissions.farms.edit).toBe(true);
      expect(result.grantedBy).toBe(mockAdminId);
    });

    it('should throw NotFoundException if permissions do not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePermissions(mockUserId, mockTenantId, {}, mockAdminId)
      ).rejects.toThrow(NotFoundException);
    });

    it('should merge permissions deeply', async () => {
      const existingPermission = {
        id: 'perm-uuid',
        userId: mockUserId,
        tenantId: mockTenantId,
        permissions: {
          ...DEFAULT_USER_PERMISSIONS,
          farms: { view: true, create: false, edit: false, delete: false },
        },
        isActive: true,
      };

      repository.findOne.mockResolvedValue(existingPermission as UserPermissions);
      repository.save.mockImplementation(async (entity) => entity as UserPermissions);

      // Only update 'create', keep other farm permissions
      const result = await service.updatePermissions(
        mockUserId,
        mockTenantId,
        { farms: { view: true, create: true, edit: false, delete: false } },
        mockAdminId
      );

      expect(result.permissions.farms.view).toBe(true); // unchanged
      expect(result.permissions.farms.create).toBe(true); // updated
      expect(result.permissions.dashboard).toEqual(DEFAULT_USER_PERMISSIONS.dashboard); // untouched category
    });
  });

  describe('hasPermission', () => {
    it('should return true for granted permission', () => {
      const permissions = TENANT_ADMIN_PERMISSIONS;

      expect(service.hasPermission(permissions, 'farms', 'create')).toBe(true);
      expect(service.hasPermission(permissions, 'users', 'editPermissions')).toBe(true);
    });

    it('should return false for denied permission', () => {
      const permissions = DEFAULT_USER_PERMISSIONS;

      expect(service.hasPermission(permissions, 'farms', 'delete')).toBe(false);
      expect(service.hasPermission(permissions, 'users', 'invite')).toBe(false);
    });

    it('should return false for non-existent category', () => {
      const permissions = DEFAULT_USER_PERMISSIONS;

      expect(service.hasPermission(permissions, 'nonexistent' as any, 'view')).toBe(false);
    });

    it('should return false for non-existent action', () => {
      const permissions = DEFAULT_USER_PERMISSIONS;

      expect(service.hasPermission(permissions, 'farms', 'nonexistent')).toBe(false);
    });
  });

  describe('getTenantUsersPermissions', () => {
    it('should return all active user permissions for tenant', async () => {
      const mockPermissions = [
        { id: '1', userId: 'user1', tenantId: mockTenantId, isActive: true },
        { id: '2', userId: 'user2', tenantId: mockTenantId, isActive: true },
      ];

      repository.find.mockResolvedValue(mockPermissions as UserPermissions[]);

      const result = await service.getTenantUsersPermissions(mockTenantId);

      expect(repository.find).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId, isActive: true },
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
    });

    it('should return empty array for tenant with no users', async () => {
      repository.find.mockResolvedValue([]);

      const result = await service.getTenantUsersPermissions(mockTenantId);

      expect(result).toEqual([]);
    });
  });

  describe('deactivatePermissions', () => {
    it('should set isActive to false', async () => {
      await service.deactivatePermissions(mockUserId, mockTenantId);

      expect(repository.update).toHaveBeenCalledWith(
        { userId: mockUserId, tenantId: mockTenantId },
        { isActive: false }
      );
    });
  });

  describe('getPermissionCategories', () => {
    it('should return all 10 permission categories', () => {
      const categories = service.getPermissionCategories();

      expect(categories).toHaveLength(10);
      expect(categories.map(c => c.category)).toEqual([
        'dashboard', 'farms', 'batches', 'feeding', 'sensors',
        'maintenance', 'hr', 'reports', 'settings', 'users'
      ]);
    });

    it('should include correct permissions for each category', () => {
      const categories = service.getPermissionCategories();

      const farmsCategory = categories.find(c => c.category === 'farms');
      expect(farmsCategory?.permissions).toContain('view');
      expect(farmsCategory?.permissions).toContain('create');
      expect(farmsCategory?.permissions).toContain('edit');
      expect(farmsCategory?.permissions).toContain('delete');

      const usersCategory = categories.find(c => c.category === 'users');
      expect(usersCategory?.permissions).toContain('invite');
      expect(usersCategory?.permissions).toContain('editPermissions');
    });
  });
});

describe('DEFAULT_USER_PERMISSIONS', () => {
  it('should have view permission for most categories', () => {
    expect(DEFAULT_USER_PERMISSIONS.dashboard.view).toBe(true);
    expect(DEFAULT_USER_PERMISSIONS.farms.view).toBe(true);
    expect(DEFAULT_USER_PERMISSIONS.batches.view).toBe(true);
    expect(DEFAULT_USER_PERMISSIONS.sensors.view).toBe(true);
  });

  it('should deny create/edit/delete for regular users', () => {
    expect(DEFAULT_USER_PERMISSIONS.farms.create).toBe(false);
    expect(DEFAULT_USER_PERMISSIONS.farms.edit).toBe(false);
    expect(DEFAULT_USER_PERMISSIONS.farms.delete).toBe(false);
  });

  it('should deny user management permissions', () => {
    expect(DEFAULT_USER_PERMISSIONS.users.view).toBe(false);
    expect(DEFAULT_USER_PERMISSIONS.users.invite).toBe(false);
    expect(DEFAULT_USER_PERMISSIONS.users.editPermissions).toBe(false);
  });

  it('should deny HR access by default', () => {
    expect(DEFAULT_USER_PERMISSIONS.hr.view).toBe(false);
    expect(DEFAULT_USER_PERMISSIONS.hr.manageEmployees).toBe(false);
  });
});

describe('TENANT_ADMIN_PERMISSIONS', () => {
  it('should have all permissions enabled', () => {
    const allTrue = Object.values(TENANT_ADMIN_PERMISSIONS).every(
      category => Object.values(category).every(perm => perm === true)
    );
    expect(allTrue).toBe(true);
  });

  it('should include user management permissions', () => {
    expect(TENANT_ADMIN_PERMISSIONS.users.view).toBe(true);
    expect(TENANT_ADMIN_PERMISSIONS.users.invite).toBe(true);
    expect(TENANT_ADMIN_PERMISSIONS.users.editPermissions).toBe(true);
    expect(TENANT_ADMIN_PERMISSIONS.users.deactivate).toBe(true);
  });
});
