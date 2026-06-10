import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
<<<<<<< HEAD
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
=======
import { Role, SchemaManagerService } from '@platform/backend-common';
import type { UserInvitedEvent } from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { ActionToken } from '../../authentication/entities/action-token.entity';
>>>>>>> origin/main
import { Invitation } from '../../authentication/entities/invitation.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { MobileUserSettings } from '../entities/mobile-user-settings.entity';
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

const createMockRepository = (): {
  find: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  count: jest.Mock;
} => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn(<T>(data: T) => ({ ...data })),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
});

const createMockTenantCounterBuilder = () => ({
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue(undefined),
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
  let mockEventBus: { publish: jest.Mock<Promise<void>, [UserInvitedEvent]> };
  let mockAuditLogService: { log: jest.Mock };

  beforeEach(async () => {
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();
    const mockRefreshTokenRepo = createMockRepository();
<<<<<<< HEAD
    // WHY: UserLifecycleService grew three repositories — MobileUserSettings
    // (accessType-driven mobile provisioning), Invitation and
    // UserModuleAssignment (atomic invite + module assignment) — so the
    // testing module must mirror the production constructor exactly.
    const mockMobileSettingsRepo = createMockRepository();
    const mockInvitationRepo = createMockRepository();
=======
    const mockMobileSettingsRepo = createMockRepository();
    const mockInvitationRepo = createMockRepository();
    const mockActionTokenRepo = createMockRepository();
>>>>>>> origin/main
    const mockUserModuleAssignmentRepo = createMockRepository();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation((cb: (manager: unknown) => Promise<unknown>) => {
        // Simulate transaction by passing a mock manager
        const mockManager = {
          getRepository: jest.fn().mockReturnValue(mockUserRepo),
          create: jest.fn(<T>(_entity: unknown, data: T) => ({ ...data })),
          save: jest.fn((_entity: unknown, data: Record<string, unknown>) =>
            Promise.resolve({ id: 'action-token-id', ...data }),
          ),
          createQueryBuilder: jest.fn(() => createMockTenantCounterBuilder()),
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
      publish: jest.fn<Promise<void>, [UserInvitedEvent]>().mockResolvedValue(undefined),
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
        { provide: getRepositoryToken(MobileUserSettings), useValue: mockMobileSettingsRepo },
        { provide: getRepositoryToken(Invitation), useValue: mockInvitationRepo },
<<<<<<< HEAD
=======
        { provide: getRepositoryToken(ActionToken), useValue: mockActionTokenRepo },
>>>>>>> origin/main
        { provide: getRepositoryToken(UserModuleAssignment), useValue: mockUserModuleAssignmentRepo },
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
  // adminInviteUser
  // ==========================================================================

  describe('adminInviteUser', () => {
    it('publishes a tokenless UserInvited event and returns no raw token', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.count.mockResolvedValue(5);
      userRepository.findOne
        .mockResolvedValueOnce(createMockUser({
          id: ADMIN_USER_ID,
          role: Role.TENANT_ADMIN,
          tenantId: TENANT_ID,
        }))
        .mockResolvedValueOnce(null);

      const txUserModuleAssignmentRepo = createMockRepository();
      const txTenantRepo = {
        increment: jest.fn().mockResolvedValue(undefined),
      };
      const invitedUser = createMockUser({
        id: 'invited-user-id',
        email: 'newuser@tenant.com',
        role: Role.MODULE_USER,
      });
      txUserModuleAssignmentRepo.save.mockResolvedValue([]);

      // User + Invitation writes go through typed manager.create/save
      // (cross-tenant auth tables — see service WHY note); only
      // UserModuleAssignment still routes through getRepository via
      // tenantManagerRepo.
      const txManager = {
        getRepository: jest.fn((entity: unknown) => {
          if (entity === UserModuleAssignment) return txUserModuleAssignmentRepo;
          if (entity === Tenant) return txTenantRepo;
          throw new Error('Unexpected repository');
        }),
        create: jest.fn(<T>(_entity: unknown, data: T) => ({ ...data })),
        save: jest.fn((entity: unknown, data: Record<string, unknown>) => {
          if (entity === User) return Promise.resolve(invitedUser);
          if (entity === Invitation) return Promise.resolve({ id: 'invitation-id', ...data });
          return Promise.resolve({ id: 'action-token-id', ...data });
        }),
        createQueryBuilder: jest.fn(() => createMockTenantCounterBuilder()),
      };
      mockDataSource.transaction.mockImplementationOnce(
        async (...args: unknown[]) => {
          const cb = args.find(
            (arg): arg is (manager: unknown) => Promise<unknown> => typeof arg === 'function',
          );
          if (!cb) throw new Error('Missing transaction callback');
          return cb(txManager);
        },
      );

      const result = await service.adminInviteUser({
        tenantId: TENANT_ID,
        email: 'newuser@tenant.com',
        role: Role.MODULE_USER,
        invitedBy: ADMIN_USER_ID,
      });

      expect(result).toEqual({
        userId: 'invited-user-id',
        invitationId: 'invitation-id',
        actionTokenId: 'action-token-id',
        deliveryStatus: 'queued',
      });
      expect(result).not.toHaveProperty('invitationToken');
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'UserInvited',
          tenantId: TENANT_ID,
          userId: 'invited-user-id',
          role: Role.MODULE_USER,
          invitedBy: ADMIN_USER_ID,
          credentialType: 'reset_token',
          actionTokenId: 'action-token-id',
          cryptoShredKeyId: 'invited-user-id',
        }),
      );
      const [publishedEvent] = mockEventBus.publish.mock.calls[0] ?? [];
      expect(JSON.stringify(publishedEvent)).not.toContain('newuser@tenant.com');
    });

    it('does not publish UserInvited when delivery is not requested', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.count.mockResolvedValue(5);
      userRepository.findOne
        .mockResolvedValueOnce(createMockUser({
          id: ADMIN_USER_ID,
          role: Role.TENANT_ADMIN,
          tenantId: TENANT_ID,
        }))
        .mockResolvedValueOnce(null);

      const txTenantRepo = {
        increment: jest.fn().mockResolvedValue(undefined),
      };
      const invitedUser = createMockUser({
        id: 'invited-user-id',
        email: 'newuser@tenant.com',
        role: Role.MODULE_USER,
      });

      // Same entity-aware manager shape as the previous test — User and
      // Invitation persist through typed manager.create/save.
      const txManager = {
        getRepository: jest.fn((entity: unknown) => {
          if (entity === UserModuleAssignment) return createMockRepository();
          if (entity === Tenant) return txTenantRepo;
          throw new Error('Unexpected repository');
        }),
        create: jest.fn(<T>(_entity: unknown, data: T) => ({ ...data })),
        save: jest.fn((entity: unknown, data: Record<string, unknown>) => {
          if (entity === User) return Promise.resolve(invitedUser);
          if (entity === Invitation) return Promise.resolve({ id: 'invitation-id', ...data });
          return Promise.resolve({ id: 'action-token-id', ...data });
        }),
        createQueryBuilder: jest.fn(() => createMockTenantCounterBuilder()),
      };
      mockDataSource.transaction.mockImplementationOnce(
        async (...args: unknown[]) => {
          const cb = args.find(
            (arg): arg is (manager: unknown) => Promise<unknown> => typeof arg === 'function',
          );
          if (!cb) throw new Error('Missing transaction callback');
          return cb(txManager);
        },
      );

      const result = await service.adminInviteUser({
        tenantId: TENANT_ID,
        email: 'newuser@tenant.com',
        role: Role.MODULE_USER,
        invitedBy: ADMIN_USER_ID,
        sendInvitation: false,
      });

      expect(result).toEqual({
        userId: 'invited-user-id',
        invitationId: 'invitation-id',
        actionTokenId: 'action-token-id',
      });
      expect(result).not.toHaveProperty('invitationToken');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
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
          revokedReason: expect.stringContaining('deleted') as string,
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
