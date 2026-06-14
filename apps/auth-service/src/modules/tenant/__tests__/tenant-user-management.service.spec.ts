/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { User } from '../../authentication/entities/user.entity';
import { MobileUserSettings } from '../entities/mobile-user-settings.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import { TenantRoleService, TenantRoleWithDetails } from '../services/tenant-role.service';
import { TenantUserManagementService } from '../services/tenant-user-management.service';
import { UserLifecycleService } from '../services/user-lifecycle.service';

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
  create: jest.fn((data: any) => ({ ...data })),
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
  // Local shape (not jest.Mocked<DataSource>) so the transaction stub need not
  // satisfy DataSource.transaction's overload set — the DI token is provided by
  // value, which is untyped, so a precise two-method double is enough. No cast.
  let mockDataSource: { query: jest.Mock; transaction: jest.Mock };
  let mockSchemaManager: jest.Mocked<Pick<SchemaManagerService, 'getTenantSchemaName'>>;
  let mockTenantRoleService: jest.Mocked<Pick<TenantRoleService, 'getRoleById'>>;
  let mockEventBus: { publish: jest.Mock };
  let mockAuditLogService: { log: jest.Mock };
  let mockUserLifecycleService: {
    createUser: jest.Mock;
    deleteUser: jest.Mock;
  };

  beforeEach(async () => {
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();
    // WHY: the service auto-provisions/deactivates mobile settings when a
    // user's accessType changes (MOBILE_ONLY/BOTH/PANEL_ONLY), so the
    // constructor now requires the MobileUserSettings repository.
    const mockMobileSettingsRepo = createMockRepository();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      // SEC-MEDIUM-002: updateUserRole runs its role UPDATE + audit inside a
      // transaction so an audit failure rolls back the role change. The mock
      // manager forwards query to the dataSource query mock (so existing
      // per-test query chains stay valid) and exposes the audit log via the
      // real auditLogService mock.
      transaction: jest.fn(
        (cb: (manager: { query: jest.Mock; save: jest.Mock }) => Promise<unknown>) =>
          cb({
            query: mockDataSource.query,
            // deleteTenantUser's soft-delete runs manager.save(user) inside the
            // transaction (SEC-MEDIUM-002); forward it to a passthrough so the
            // audit-rollback assertions still hinge on the auditLogService mock.
            save: jest.fn((entity: unknown) => Promise.resolve(entity)),
          }),
      ),
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

    // Default mock for UserLifecycleService — used by createTenantUser/deleteTenantUser delegation
    mockUserLifecycleService = {
      createUser: jest.fn().mockResolvedValue({
        user: createMockUser({ email: 'newuser@tenant.com' }),
        roleAssignment: {
          id: 'assignment-001',
          userId: USER_ID,
          roleId: ROLE_ID,
          roleName: 'Operator',
          roleColor: '#10B981',
          roleIcon: 'activity',
          roleLevel: 30,
          permissionOverrides: { grants: [], revokes: [] },
          panelPermissions: {},
          resourcePermissions: ['sites:view', 'sensors:view'],
          effectivePermissions: ['sites:view', 'sensors:view'],
          isActive: true,
          expiresAt: null,
          assignedAt: new Date(),
          assignedBy: ADMIN_USER_ID,
        },
        invitationSent: false,
      }),
      deleteUser: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantUserManagementService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
        { provide: getRepositoryToken(MobileUserSettings), useValue: mockMobileSettingsRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SchemaManagerService, useValue: mockSchemaManager },
        { provide: TenantRoleService, useValue: mockTenantRoleService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        // The service injects BestEffortEventPublisher (not the raw bus) for the
        // allowlisted UserInvited event; wrap the same mock so publish assertions
        // continue to observe what the service emits (DATA-HIGH-001).
        {
          provide: BestEffortEventPublisher,
          useValue: new BestEffortEventPublisher(mockEventBus),
        },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: UserLifecycleService, useValue: mockUserLifecycleService },
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
  // createTenantUser (delegates to UserLifecycleService)
  // ==========================================================================

  describe('createTenantUser', () => {
    const createInput = {
      firstName: 'New',
      lastName: 'User',
      email: 'newuser@tenant.com',
      roleId: ROLE_ID,
    };

    beforeEach(() => {
      // WHY: createTenantUser validates tenant existence before delegating to
      // UserLifecycleService — prime an existing tenant so delegation tests
      // exercise the delegation contract, not the guard clause.
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
    });

    it('should delegate to UserLifecycleService.createUser', async () => {
      const result = await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(mockUserLifecycleService.createUser).toHaveBeenCalledWith(
        TENANT_ID,
        createInput,
        ADMIN_USER_ID,
        true, // sendInvitation defaults to true
      );
      expect(result.user).toBeDefined();
      expect(result.roleAssignment).toBeDefined();
    });

    it('should pass sendInvitation=false when specified', async () => {
      await service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID, false);

      expect(mockUserLifecycleService.createUser).toHaveBeenCalledWith(
        TENANT_ID,
        createInput,
        ADMIN_USER_ID,
        false,
      );
    });

    it('should propagate errors from UserLifecycleService', async () => {
      mockUserLifecycleService.createUser.mockRejectedValue(
        new ConflictException('User already exists'),
      );

      await expect(
        service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('should propagate NotFoundException from UserLifecycleService', async () => {
      mockUserLifecycleService.createUser.mockRejectedValue(
        new NotFoundException('Tenant not found'),
      );

      await expect(
        service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==========================================================================
  // assignUserRole
  // ==========================================================================

  describe('assignUserRole', () => {
    it('should assign a role to an existing tenant user', async () => {
      // WHY admin actor: assertRoleGrantAuthority (SEC-MEDIUM-001) looks up
      // the acting user; a global TENANT_ADMIN outranks every tenant role so
      // the ceiling query is skipped and the dataSource.query chain is the
      // existing [active-check, INSERT].
      const adminActor = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminActor);
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
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query.mockResolvedValueOnce([{ id: 'existing-assignment' }]); // existing active

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(ConflictException);
    });

    it('SEC-MEDIUM-001: rejects self-modification of own role assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());

      // assignedBy === target userId → self-target is forbidden.
      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, USER_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it('SEC-MEDIUM-001: rejects a non-admin granting a role above their ceiling', async () => {
      // Actor is a non-admin tenant user (MODULE_USER) → ceiling derives from
      // their highest active tenant-role level.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.MODULE_USER }));
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ level: 90 }), // high-privilege target role
      );
      // assertRoleGrantAuthority's ceiling query returns the actor's level (30).
      mockDataSource.query.mockResolvedValueOnce([{ level: 30 }]);

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ==========================================================================
  // updateUserRole
  // ==========================================================================

  describe('updateUserRole', () => {
    it('should update role assignment and log audit event ATOMICALLY (SEC-MEDIUM-002)', async () => {
      // Admin actor → ceiling query skipped (SEC-MEDIUM-001). The role UPDATE
      // and audit now run inside dataSource.transaction; the mock manager
      // forwards query to the same chain, so [existing, UPDATE, final-SELECT].
      const adminActor = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminActor);
      // Existing active assignment
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID }]) // existing
        .mockResolvedValueOnce([]) // UPDATE (inside transaction)
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
      // Audit ran INSIDE the transaction (fail-closed).
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
        }),
      );
    });

    it('SEC-MEDIUM-002: an audit failure ROLLS BACK the role change (fail-closed)', async () => {
      const adminActor = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminActor);
      mockDataSource.query.mockResolvedValueOnce([
        { id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID },
      ]); // existing
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id' }),
      );
      // The audit write fails inside the transaction → the whole update aborts.
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(
        service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID),
      ).rejects.toThrow('audit DB down');
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

    // NOTE (SEC-MEDIUM-002): the former "should not throw if audit log fails
    // (non-critical)" test asserted the FAIL-OPEN behaviour that was the
    // vulnerability — a role change persisting with no audit evidence. It was
    // replaced by the fail-closed contract above ("an audit failure ROLLS
    // BACK the role change"). A permission-override-only change is likewise
    // now atomic with its audit:
    it('SEC-MEDIUM-002: permission-override change also aborts when its audit fails', async () => {
      const adminActor = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminActor);
      mockDataSource.query.mockResolvedValueOnce([
        { id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID },
      ]); // existing
      mockAuditLogService.log.mockRejectedValueOnce(new Error('Audit DB down'));

      await expect(
        service.updateUserRole(
          TENANT_ID,
          USER_ID,
          { permissionOverrides: { grants: ['x:y'], revokes: [] } },
          ADMIN_USER_ID,
        ),
      ).rejects.toThrow('Audit DB down');
    });
  });

  // ==========================================================================
  // updateTenantUser — D1 (Wave-5): role-change authority guard + fail-closed audit
  // ==========================================================================

  describe('updateTenantUser', () => {
    it('SEC-MEDIUM-002: role change + audit commit ATOMICALLY inside a transaction', async () => {
      // Admin actor → assertRoleGrantAuthority ceiling query skipped. Query
      // chain: [SELECT existing assignment, UPDATE inside transaction].
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id', name: 'Supervisor' }),
      );
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'a1', role_id: ROLE_ID }]) // existing (old role)
        .mockResolvedValueOnce([]); // UPDATE (inside transaction)

      await service.updateTenantUser(
        TENANT_ID,
        USER_ID,
        { roleId: 'new-role-id' },
        ADMIN_USER_ID,
      );

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
          previousValue: { roleId: ROLE_ID },
          newValue: { roleId: 'new-role-id' },
        }),
      );
    });

    it('SEC-MEDIUM-001: rejects a self role change (acting user === target)', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id' }),
      );

      await expect(
        service.updateTenantUser(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, USER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('SEC-MEDIUM-001: rejects a non-admin granting a role above their ceiling', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(createMockUser()) // target
        .mockResolvedValueOnce(createMockUser({ id: ADMIN_USER_ID, role: Role.MODULE_USER })); // actor
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id', level: 90 }),
      );
      mockDataSource.query.mockResolvedValueOnce([{ level: 30 }]); // actor ceiling

      await expect(
        service.updateTenantUser(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('SEC-MEDIUM-002: an audit failure ROLLS BACK the role change (fail-closed)', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id' }),
      );
      mockDataSource.query.mockResolvedValueOnce([{ id: 'a1', role_id: ROLE_ID }]); // existing
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(
        service.updateTenantUser(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID),
      ).rejects.toThrow('audit DB down');
    });

    it('SEC-MEDIUM-002: a NEW assignment (no existing) is INSERTed with an audit row, atomically', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id' }),
      );
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing assignment
        .mockResolvedValueOnce([]); // INSERT (inside transaction)

      await service.updateTenantUser(
        TENANT_ID,
        USER_ID,
        { roleId: 'new-role-id' },
        ADMIN_USER_ID,
      );

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          previousValue: { roleId: null },
          newValue: { roleId: 'new-role-id' },
        }),
      );
    });

    it('allows a profile-only update on self without the role guard or a transaction', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());

      await service.updateTenantUser(TENANT_ID, USER_ID, { firstName: 'Renamed' }, USER_ID);

      expect(userRepository.save).toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(mockAuditLogService.log).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // deleteTenantUser — D1 (Wave-5): fail-closed soft-delete audit
  // ==========================================================================

  describe('deleteTenantUser', () => {
    it('SEC-MEDIUM-002: soft-delete, role revoke, and audit commit ATOMICALLY', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(createMockUser({ role: Role.MODULE_USER })) // target
        .mockResolvedValueOnce(createMockUser({ id: ADMIN_USER_ID, email: 'admin@t.com', role: Role.TENANT_ADMIN })); // admin lookup

      const result = await service.deleteTenantUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_DELETED',
          entityType: 'User',
          entityId: USER_ID,
        }),
      );
    });

    it('rejects self-deletion', async () => {
      await expect(
        service.deleteTenantUser(TENANT_ID, USER_ID, USER_ID),
      ).rejects.toThrow(BadRequestException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses to delete another TENANT_ADMIN', async () => {
      userRepository.findOne.mockResolvedValueOnce(createMockUser({ role: Role.TENANT_ADMIN }));

      await expect(
        service.deleteTenantUser(TENANT_ID, USER_ID, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('SEC-MEDIUM-002: an audit failure ROLLS BACK the soft-delete (fail-closed)', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(createMockUser({ role: Role.MODULE_USER })) // target
        .mockResolvedValueOnce(createMockUser({ id: ADMIN_USER_ID, role: Role.TENANT_ADMIN })); // admin lookup
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(
        service.deleteTenantUser(TENANT_ID, USER_ID, ADMIN_USER_ID),
      ).rejects.toThrow('audit DB down');
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
      // The acting admin outranks every tenant role (SEC-MEDIUM-001), so the
      // ceiling query is skipped and the per-user query chain is unchanged.
      const adminActor = createMockUser({ id: ADMIN_USER_ID, role: Role.TENANT_ADMIN });
      const userIds = ['user-a', 'user-b', 'user-c'];

      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());

      // WHY id-keyed: assignUserRole now looks up BOTH the target user and the
      // acting user (assertRoleGrantAuthority) — resolve by id rather than a
      // brittle call-order chain.
      const usersById: Record<string, User | null> = {
        'user-a': userA,
        'user-b': userB,
        'user-c': null,
        [ADMIN_USER_ID]: adminActor,
      };
      userRepository.findOne.mockImplementation(
        (opts) =>
          Promise.resolve(
            usersById[(opts as { where: { id: string } }).where.id] ?? null,
          ),
      );

      // user-a + user-b each: [no-existing, INSERT]; user-c never reaches the
      // queries (findOne returns null first).
      mockDataSource.query
        .mockResolvedValueOnce([]) // user-a: no existing
        .mockResolvedValueOnce([{ id: 'assign-a' }]) // user-a: INSERT
        .mockResolvedValueOnce([]) // user-b: no existing
        .mockResolvedValueOnce([{ id: 'assign-b' }]); // user-b: INSERT

      const result = await service.bulkAssignRole(TENANT_ID, userIds, ROLE_ID, ADMIN_USER_ID);

      expect(result.success).toContain('user-a');
      expect(result.success).toContain('user-b');
      expect(result.failed).toHaveLength(1);
      const [failedEntry] = result.failed;
      if (!failedEntry) {
        throw new Error('expected exactly one failed bulk-assign entry');
      }
      expect(failedEntry.userId).toBe('user-c');
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
