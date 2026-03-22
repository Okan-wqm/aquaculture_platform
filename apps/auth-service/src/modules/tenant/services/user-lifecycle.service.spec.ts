/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Role, SchemaManagerService } from '@platform/backend-common';

import { AuditLogService } from '../../../audit/audit-log.service';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { User } from '../../authentication/entities/user.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';
import { UserLifecycleService } from './user-lifecycle.service';

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
  count: jest.fn(),
});

// ============================================================================
// Tests
// ============================================================================

describe('UserLifecycleService', () => {
  let service: UserLifecycleService;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let refreshTokenRepository: jest.Mocked<Repository<RefreshToken>>;
  let mockDataSource: jest.Mocked<Pick<DataSource, 'query' | 'transaction'>>;
  let mockSchemaManager: jest.Mocked<Pick<SchemaManagerService, 'getTenantSchemaName'>>;
  let mockTenantRoleService: jest.Mocked<Pick<TenantRoleService, 'getRoleById'>>;
  let mockEventBus: { publish: jest.Mock };
  let mockAuditLogService: { log: jest.Mock };

  beforeEach(async () => {
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();
    const mockRefreshTokenRepo = createMockRepository();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (cb: any) => {
        // Simulate transaction by passing a mock manager
        const mockManager = {
          getRepository: jest.fn().mockReturnValue(mockUserRepo),
          query: mockDataSource.query,
        };
        return cb(mockManager);
      }),
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
        UserLifecycleService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRefreshTokenRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SchemaManagerService, useValue: mockSchemaManager },
        { provide: TenantRoleService, useValue: mockTenantRoleService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<UserLifecycleService>(UserLifecycleService);
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
    refreshTokenRepository = module.get(getRepositoryToken(RefreshToken));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // createUser
  // ==========================================================================

  describe('createUser', () => {
    const createInput = {
      firstName: 'New',
      lastName: 'User',
      email: 'newuser@tenant.com',
      roleId: ROLE_ID,
    };

    it('should create user with role assignment in a single flow', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null); // no existing user
      const savedUser = createMockUser({ email: 'newuser@tenant.com' });
      userRepository.save.mockResolvedValue(savedUser);
      // createRoleAssignment INSERT returns id
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createUser(TENANT_ID, createInput, ADMIN_USER_ID);

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

    it('should throw ConflictException for duplicate email', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(createMockUser());

      await expect(
        service.createUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when tenant does not exist', async () => {
      tenantRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when role does not exist', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      mockTenantRoleService.getRoleById.mockResolvedValue(null);

      await expect(
        service.createUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // deleteUser
  // ==========================================================================

  describe('deleteUser', () => {
    it('should deactivate user AND revoke all refresh tokens (CRITICAL)', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      // 1. User should be deactivated
      expect(userRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );

      // 2. CRITICAL: Refresh tokens must be revoked
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: USER_ID, isRevoked: false },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: expect.stringContaining('deleted'),
        }),
      );
    });

    it('should prevent self-deletion', async () => {
      await expect(
        service.deleteUser(TENANT_ID, ADMIN_USER_ID, ADMIN_USER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('should prevent deleting another TENANT_ADMIN', async () => {
      const adminUser = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminUser);

      await expect(
        service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when user does not exist in tenant', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteUser(TENANT_ID, 'nonexistent-user', ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should revoke role assignments in tenant schema', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      // Should query tenant schema to revoke role assignments
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('user_role_assignments'),
        expect.arrayContaining([USER_ID]),
      );
    });

    it('should log audit event for user deletion', async () => {
      const user = createMockUser();
      userRepository.findOne
        .mockResolvedValueOnce(user) // target user lookup
        .mockResolvedValueOnce(createMockUser({ id: ADMIN_USER_ID, email: 'admin@tenant.com' })); // admin lookup for audit

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_DELETED',
          entityId: USER_ID,
        }),
      );
    });
  });
});
