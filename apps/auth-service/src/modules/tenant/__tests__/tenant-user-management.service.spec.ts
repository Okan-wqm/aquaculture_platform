/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-floating-promises */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Role, SchemaManagerService } from '@aquaculture/backend-common';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../../authentication/entities/user.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import { TenantRoleService, TenantRoleWithDetails } from '../services/tenant-role.service';
import { TenantUserManagementService } from '../services/tenant-user-management.service';

// ============================================================================
// Constants
// ============================================================================

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_SCHEMA = `tenant_${TENANT_ID.replace(/-/g, '_')}`;
const USER_ID = 'user-uuid-001';
const ADMIN_USER_ID = 'admin-uuid-001';
const ROLE_ID = 'role-uuid-001';

// ============================================================================
// Mock Helpers
// ============================================================================

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: USER_ID,
    email: 'testuser@tenant.com',
    firstName: 'Test',
    lastName: 'User',
    role: Role.MODULE_USER,
    tenantId: TENANT_ID,
    isActive: true,
    isEmailVerified: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return user;
};

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: TENANT_ID,
    name: 'Test Tenant',
    slug: 'test-tenant',
    status: TenantStatus.ACTIVE,
    plan: TenantPlan.PROFESSIONAL,
    maxUsers: 50,
    userCount: 5,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return tenant;
};

const createMockRoleWithDetails = (
  overrides: Partial<TenantRoleWithDetails> = {},
): TenantRoleWithDetails => ({
  id: ROLE_ID,
  name: 'Operator',
  description: 'Basic operational access',
  color: '#10B981',
  icon: 'activity',
  level: 30,
  isSystem: true,
  isDefault: true,
  userCount: 5,
  permissions: {
    id: 'perm-uuid-001',
    roleId: ROLE_ID,
    panelPermissions: {
      farm: { sites: { view: true, create: false, edit: false, delete: false } },
      operations: { sensors: { view: true, configure: false } },
    },
    resourcePermissions: ['sites:view', 'sensors:view'],
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ============================================================================
// Mock Setup
// ============================================================================

const createMockRepository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn((data: any) => ({ ...data } as any)),
  update: jest.fn(),
  delete: jest.fn(),
});

// ============================================================================
// Tests
// ============================================================================

describe('TenantUserManagementService', () => {
  let service: TenantUserManagementService;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let mockDataSource: jest.Mocked<Pick<DataSource, 'query'>>;
  let mockSchemaManager: jest.Mocked<Pick<SchemaManagerService, 'getTenantSchemaName'>>;
  let mockTenantRoleService: jest.Mocked<Pick<TenantRoleService, 'getRoleById'>>;
  let mockEventBus: { publish: jest.Mock };
  let mockAuditLogService: { log: jest.Mock };

  beforeEach(async () => {
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
    };

    mockSchemaManager = {
      getTenantSchemaName: jest.fn().mockReturnValue(TENANT_SCHEMA),
    };

    mockTenantRoleService = {
      getRoleById: jest.fn().mockResolvedValue(createMockRoleWithDetails()),
    };

    mockEventBus = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    mockAuditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantUserManagementService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SchemaManagerService, useValue: mockSchemaManager },
        { provide: TenantRoleService, useValue: mockTenantRoleService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<TenantUserManagementService>(TenantUserManagementService);
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // createTenantUser
  // ==========================================================================

  describe('createTenantUser', () => {
    const createInput = {
      firstName: 'New',
      lastName: 'User',
      email: 'newuser@tenant.com',
      roleId: ROLE_ID,
    };

    it('should create user with MODULE_USER global role', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null); // no duplicate
      const savedUser = createMockUser({ email: 'newuser@tenant.com' });
      userRepository.save.mockResolvedValue(savedUser);
      // createRoleAssignment INSERT
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(result.user).toBeDefined();
      expect(result.roleAssignment).toBeDefined();
      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.MODULE_USER,
          tenantId: TENANT_ID,
          isActive: true,
        }),
      );
    });

    it('should normalize email to lowercase', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      await service.createTenantUser(
        TENANT_ID,
        { ...createInput, email: 'Test@TENANT.COM' },
        ADMIN_USER_ID,
      );

      // findOne should use lowercase email
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'test@tenant.com' },
      });
      // Create should use lowercase email
      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@tenant.com' }),
      );
    });

    it('should throw ConflictException for duplicate email', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(createMockUser()); // existing user found

      await expect(
        service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when tenant does not exist', async () => {
      tenantRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when role does not exist in tenant', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      mockTenantRoleService.getRoleById.mockResolvedValue(null);

      await expect(
        service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should generate SHA-256 hashed invitation token when no password provided', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, true);

      // The create call should have a hashed invitation token (SHA-256 = 64 hex chars)
      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          invitationToken: expect.stringMatching(/^[0-9a-f]{64}$/),
          invitationExpiresAt: expect.any(Date),
        }),
      );
    });

    it('should set invitation expiry to 7 days from now', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const before = Date.now();
      await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, true);
      const after = Date.now();

      const createCall = userRepository.create.mock.calls[0]![0] as any;
      const expiresAt = createCall.invitationExpiresAt.getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDaysMs - 5000);
      expect(expiresAt).toBeLessThanOrEqual(after + sevenDaysMs + 5000);
    });

    it('should not generate invitation token when password is provided', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      await service.createTenantUser(
        TENANT_ID,
        { ...createInput, password: 'SecurePass123!' },
        ADMIN_USER_ID,
        true,
      );

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          invitationToken: null,
          invitationExpiresAt: null,
          password: 'SecurePass123!',
        }),
      );
    });

    it('should publish UserInvited event with plain token (not hash)', async () => {
      process.env['APP_URL'] = 'https://app.test.com';

      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      const savedUser = createMockUser({
        email: 'newuser@tenant.com',
        invitedBy: ADMIN_USER_ID,
      });
      userRepository.save.mockResolvedValue(savedUser);
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, true);

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      const event = mockEventBus.publish.mock.calls[0][0];
      expect(event.eventType).toBe('UserInvited');
      expect(event.email).toBe(savedUser.email);
      // actionUrl should contain a 64-char hex token (plain, not hashed)
      expect(event.actionUrl).toMatch(/\/accept-invitation\/[0-9a-f]{64}$/);

      delete process.env['APP_URL'];
    });

    it('should not send invitation when sendInvitation is false', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, false);

      expect(result.invitationSent).toBe(false);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('should assign role in tenant schema after user creation', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      const savedUser = createMockUser({ id: 'new-user-id' });
      userRepository.save.mockResolvedValue(savedUser);
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, false);

      expect(result.roleAssignment).toBeDefined();
      expect(result.roleAssignment.roleId).toBe(ROLE_ID);
      expect(result.roleAssignment.roleName).toBe('Operator');
      // Verify the INSERT went to the correct schema
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(TENANT_SCHEMA),
        expect.any(Array),
      );
    });

    it('should handle invitation email failure gracefully (set invitationSent = false)', async () => {
      process.env['APP_URL'] = 'https://app.test.com';

      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);
      mockEventBus.publish.mockRejectedValueOnce(new Error('SMTP error'));

      const result = await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, true);

      // User should still be created, just invitationSent = false
      expect(result.user).toBeDefined();
      expect(result.invitationSent).toBe(false);

      delete process.env['APP_URL'];
    });

    it('should pass permission overrides to role assignment', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const overrides = {
        grants: ['sensors:configure'],
        revokes: ['sites:view'],
      };

      const result = await service.createTenantUser(
        TENANT_ID,
        { ...createInput, permissionOverrides: overrides },
        ADMIN_USER_ID,
        false,
      );

      expect(result.roleAssignment.permissionOverrides).toEqual(overrides);
    });
  });

  // ==========================================================================
  // calculateEffectivePermissions (via createTenantUser)
  // ==========================================================================

  describe('calculateEffectivePermissions', () => {
    it('should combine base permissions with grants and revokes', async () => {
      // Role has sites:view, sensors:view
      // Override: grant sensors:configure, revoke sites:view
      const role = createMockRoleWithDetails({
        permissions: {
          id: 'perm-1',
          roleId: ROLE_ID,
          panelPermissions: {},
          resourcePermissions: ['sites:view', 'sensors:view'],
        },
      });
      mockTenantRoleService.getRoleById.mockResolvedValue(role);
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(
        TENANT_ID,
        {
          firstName: 'New',
          lastName: 'User',
          email: 'perm-test@tenant.com',
          roleId: ROLE_ID,
          permissionOverrides: {
            grants: ['sensors:configure'],
            revokes: ['sites:view'],
          },
        },
        ADMIN_USER_ID,
        false,
      );

      const effective = result.roleAssignment.effectivePermissions;
      expect(effective).toContain('sensors:view'); // from base
      expect(effective).toContain('sensors:configure'); // granted
      expect(effective).not.toContain('sites:view'); // revoked
    });

    it('should return base permissions when no overrides provided', async () => {
      const role = createMockRoleWithDetails({
        permissions: {
          id: 'perm-1',
          roleId: ROLE_ID,
          panelPermissions: {},
          resourcePermissions: ['sites:view', 'sensors:view', 'tanks:view'],
        },
      });
      mockTenantRoleService.getRoleById.mockResolvedValue(role);
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(
        TENANT_ID,
        {
          firstName: 'Base',
          lastName: 'Perm',
          email: 'base@tenant.com',
          roleId: ROLE_ID,
        },
        ADMIN_USER_ID,
        false,
      );

      const effective = result.roleAssignment.effectivePermissions;
      expect(effective).toEqual(expect.arrayContaining(['sites:view', 'sensors:view', 'tanks:view']));
      expect(effective).toHaveLength(3);
    });

    it('should handle empty role permissions with grants', async () => {
      const role = createMockRoleWithDetails({
        permissions: {
          id: 'perm-1',
          roleId: ROLE_ID,
          panelPermissions: {},
          resourcePermissions: [],
        },
      });
      mockTenantRoleService.getRoleById.mockResolvedValue(role);
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(
        TENANT_ID,
        {
          firstName: 'Empty',
          lastName: 'Base',
          email: 'empty@tenant.com',
          roleId: ROLE_ID,
          permissionOverrides: {
            grants: ['sensors:calibrate'],
            revokes: [],
          },
        },
        ADMIN_USER_ID,
        false,
      );

      expect(result.roleAssignment.effectivePermissions).toEqual(['sensors:calibrate']);
    });

    it('should handle role with null permissions', async () => {
      const role = createMockRoleWithDetails({ permissions: null });
      mockTenantRoleService.getRoleById.mockResolvedValue(role);
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createTenantUser(
        TENANT_ID,
        {
          firstName: 'Null',
          lastName: 'Perms',
          email: 'null@tenant.com',
          roleId: ROLE_ID,
        },
        ADMIN_USER_ID,
        false,
      );

      expect(result.roleAssignment.effectivePermissions).toEqual([]);
    });
  });

  // ==========================================================================
  // assignUserRole
  // ==========================================================================

  describe('assignUserRole', () => {
    it('should assign a role to an existing tenant user', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing active assignment
        .mockResolvedValueOnce([{ id: 'new-assignment-id' }]); // INSERT

      const result = await service.assignUserRole(
        TENANT_ID,
        USER_ID,
        { roleId: ROLE_ID },
        ADMIN_USER_ID,
      );

      expect(result.userId).toBe(USER_ID);
      expect(result.roleId).toBe(ROLE_ID);
      expect(result.isActive).toBe(true);
    });

    it('should throw NotFoundException when user does not belong to tenant', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assignUserRole(TENANT_ID, 'wrong-user', { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when user already has active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'existing-assignment' }]); // existing active

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ==========================================================================
  // updateUserRole
  // ==========================================================================

  describe('updateUserRole', () => {
    it('should update role assignment and log audit event', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      // Existing active assignment
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID }]) // existing
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([{
          id: 'assignment-1',
          user_id: USER_ID,
          role_id: 'new-role-id',
          role_name: 'Supervisor',
          role_color: '#8B5CF6',
          role_icon: 'user-check',
          role_level: 70,
          permission_overrides: null,
          panel_permissions: '{}',
          resource_permissions: [],
          is_active: true,
          expires_at: null,
          created_at: new Date(),
          assigned_by: ADMIN_USER_ID,
        }]); // getUserRoleAssignment

      const newRole = createMockRoleWithDetails({ id: 'new-role-id', name: 'Supervisor' });
      mockTenantRoleService.getRoleById.mockResolvedValue(newRole);

      const result = await service.updateUserRole(
        TENANT_ID,
        USER_ID,
        { roleId: 'new-role-id' },
        ADMIN_USER_ID,
      );

      expect(result).toBeDefined();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
        }),
      );
    });

    it('should throw NotFoundException when user does not exist in tenant', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'new-role' }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when no active assignment exists', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([]); // no active assignment

      await expect(
        service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'new-role' }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when new role does not exist', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([
        { id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID },
      ]);
      mockTenantRoleService.getRoleById.mockResolvedValue(null);

      await expect(
        service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'non-existent' }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not throw if audit log fails (non-critical)', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([{
          id: 'assignment-1',
          user_id: USER_ID,
          role_id: ROLE_ID,
          role_name: 'Operator',
          role_color: '#10B981',
          role_icon: 'activity',
          role_level: 30,
          permission_overrides: null,
          panel_permissions: '{}',
          resource_permissions: [],
          is_active: true,
          expires_at: null,
          created_at: new Date(),
          assigned_by: ADMIN_USER_ID,
        }]);

      mockAuditLogService.log.mockRejectedValueOnce(new Error('Audit DB down'));

      // Should not throw, even though audit log failed
      await expect(
        service.updateUserRole(
          TENANT_ID,
          USER_ID,
          { permissionOverrides: { grants: ['x:y'], revokes: [] } },
          ADMIN_USER_ID,
        ),
      ).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // revokeUserRole
  // ==========================================================================

  describe('revokeUserRole', () => {
    it('should soft-delete role assignment by default', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1' }]) // existing active
        .mockResolvedValueOnce([]); // UPDATE is_active = false

      const result = await service.revokeUserRole(TENANT_ID, USER_ID, false, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('is_active = false'),
        expect.any(Array),
      );
    });

    it('should hard-delete role assignment when requested', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1' }])
        .mockResolvedValueOnce([]); // DELETE

      const result = await service.revokeUserRole(TENANT_ID, USER_ID, true, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('DELETE'),
        expect.any(Array),
      );
    });

    it('should throw NotFoundException when user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeUserRole(TENANT_ID, 'wrong-user', false, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when no active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([]); // no active assignment

      await expect(
        service.revokeUserRole(TENANT_ID, USER_ID, false, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // getUserEffectivePermissions
  // ==========================================================================

  describe('getUserEffectivePermissions', () => {
    it('should return effective permissions for a user with active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{
        user_id: USER_ID,
        role_id: ROLE_ID,
        role_name: 'Operator',
        role_color: '#10B981',
        role_icon: 'activity',
        role_level: 30,
        permission_overrides: JSON.stringify({ grants: ['sensors:configure'], revokes: [] }),
        panel_permissions: JSON.stringify({ farm: { sites: { view: true } } }),
        resource_permissions: ['sites:view', 'sensors:view'],
        is_active: true,
      }]);

      const result = await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(result.roleId).toBe(ROLE_ID);
      expect(result.roleName).toBe('Operator');
      expect(result.resourcePermissions).toEqual(['sites:view', 'sensors:view']);
      expect(result.overrides.grants).toEqual(['sensors:configure']);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getUserEffectivePermissions(TENANT_ID, 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when no active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([]); // no active assignment

      await expect(
        service.getUserEffectivePermissions(TENANT_ID, USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle null permission_overrides gracefully', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{
        user_id: USER_ID,
        role_id: ROLE_ID,
        role_name: 'Viewer',
        role_color: '#6B7280',
        role_icon: 'eye',
        role_level: 10,
        permission_overrides: null,
        panel_permissions: null,
        resource_permissions: ['sites:view'],
        is_active: true,
      }]);

      const result = await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(result.overrides).toEqual({ grants: [], revokes: [] });
      expect(result.panelPermissions).toEqual({});
    });

    it('should handle string-formatted permission_overrides', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([{
        user_id: USER_ID,
        role_id: ROLE_ID,
        role_name: 'Operator',
        role_color: '#10B981',
        role_icon: 'activity',
        role_level: 30,
        permission_overrides: '{"grants":["tanks:edit"],"revokes":["sensors:view"]}',
        panel_permissions: '{"farm":{"sites":{"view":true}}}',
        resource_permissions: ['sites:view', 'sensors:view'],
        is_active: true,
      }]);

      const result = await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(result.overrides.grants).toEqual(['tanks:edit']);
      expect(result.overrides.revokes).toEqual(['sensors:view']);
      expect(result.panelPermissions).toEqual({ farm: { sites: { view: true } } });
    });
  });

  // ==========================================================================
  // bulkAssignRole
  // ==========================================================================

  describe('bulkAssignRole', () => {
    it('should assign role to multiple users and report successes/failures', async () => {
      const userA = createMockUser({ id: 'user-a' });
      const userB = createMockUser({ id: 'user-b' });
      const userIds = ['user-a', 'user-b', 'user-c'];

      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());

      // user-a: success
      userRepository.findOne
        .mockResolvedValueOnce(userA); // assignUserRole -> findOne
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing for user-a
        .mockResolvedValueOnce([{ id: 'assign-a' }]); // INSERT for user-a

      // user-b: success
      userRepository.findOne
        .mockResolvedValueOnce(userB);
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'assign-b' }]);

      // user-c: fails (not found)
      userRepository.findOne
        .mockResolvedValueOnce(null);

      const result = await service.bulkAssignRole(TENANT_ID, userIds, ROLE_ID, ADMIN_USER_ID);

      expect(result.success).toContain('user-a');
      expect(result.success).toContain('user-b');
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.userId).toBe('user-c');
    });

    it('should throw NotFoundException when role does not exist', async () => {
      mockTenantRoleService.getRoleById.mockResolvedValue(null);

      await expect(
        service.bulkAssignRole(TENANT_ID, ['user-a'], 'bad-role', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // Tenant Isolation
  // ==========================================================================

  describe('Tenant Isolation', () => {
    it('should always scope user lookup by tenantId', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValue([{
        user_id: USER_ID,
        role_id: ROLE_ID,
        role_name: 'Operator',
        role_color: '#10B981',
        role_icon: 'activity',
        role_level: 30,
        permission_overrides: null,
        panel_permissions: '{}',
        resource_permissions: [],
        is_active: true,
      }]);

      await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID, tenantId: TENANT_ID },
      });
    });

    it('should use tenant-specific schema for all role assignment queries', async () => {
      const otherTenantId = '22222222-2222-2222-2222-222222222222';
      const otherSchema = 'tenant_22222222_2222_2222_2222_222222222222';
      mockSchemaManager.getTenantSchemaName.mockReturnValue(otherSchema);

      userRepository.findOne.mockResolvedValue(createMockUser({ tenantId: otherTenantId }));
      mockDataSource.query.mockResolvedValue([{
        user_id: USER_ID,
        role_id: ROLE_ID,
        role_name: 'Op',
        role_color: '#10B981',
        role_icon: 'activity',
        role_level: 30,
        permission_overrides: null,
        panel_permissions: '{}',
        resource_permissions: [],
        is_active: true,
      }]);

      await service.getUserEffectivePermissions(otherTenantId, USER_ID);

      expect(mockSchemaManager.getTenantSchemaName).toHaveBeenCalledWith(otherTenantId);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(otherSchema),
        expect.any(Array),
      );
    });
  });
});
