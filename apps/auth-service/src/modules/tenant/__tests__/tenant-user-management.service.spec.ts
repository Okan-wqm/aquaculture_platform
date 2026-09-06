import { Role } from '@aquaculture/backend-common/decorators';
import { USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../authentication/services/durable-user-token-invalidation.service';
import { MobileUserSettings } from '../entities/mobile-user-settings.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';

import { CapabilityAuthorityService, ActorAuthority } from '../services/capability-authority';
import { TenantRoleService, TenantRoleWithDetails } from '../services/tenant-role.service';
import { TenantUserManagementService } from '../services/tenant-user-management.service';
import { UserLifecycleService } from '../services/user-lifecycle.service';

// ============================================================================
// Constants
// ============================================================================

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
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
    credentialVersion: 1,
    accessTokenInvalidBeforeEpochSeconds: 0,
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
  create: jest.fn(<T>(data: T) => ({ ...data })),
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
  let mockTenantRoleService: jest.Mocked<Pick<TenantRoleService, 'getRoleById'>>;
  let mockAuditLogService: { log: jest.Mock };
  let mockUserLifecycleService: {
    createUser: jest.Mock;
    deleteUser: jest.Mock;
  };
  // SECURITY (RBAC-C1/C2): the write-time grant-authority SSoT. Default mock
  // behaves as a tenant admin (may grant anything, pass-through overrides); tests
  // exercising delegate containment override resolveActorAuthority / the asserts.
  let mockCapabilityAuthority: {
    resolveActorAuthority: jest.Mock;
    assertGrantableOverrides: jest.Mock;
    assertGrantableResourcePermissions: jest.Mock;
    emptyOverrides: jest.Mock;
  };
  // RBAC-HIGH-001: canonical user-token-revocation mock.
  let mockUserTokenRevocation: { revokeUserTokens: jest.Mock; isTokenValid: jest.Mock };
  let mockDurableInvalidation: { enqueue: jest.Mock; applyImmediately: jest.Mock };

  beforeEach(async () => {
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();
    mockTenantRepo.findOne.mockResolvedValue(createMockTenant());
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
      transaction: jest.fn((cb: (manager: object) => Promise<unknown>) =>
        cb({
          queryRunner: { isTransactionActive: true },
          findOne: jest.fn(async (entity: unknown, options: { where: { id: string } }) => {
            if (entity === Tenant) return mockTenantRepo.findOne(options);
            if (entity === User) return createMockUser({ id: options.where.id });
            throw new Error('Unexpected role identity lookup');
          }),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          query: mockDataSource.query,
          // deleteTenantUser's soft-delete runs manager.save(user) inside the
          // transaction (SEC-MEDIUM-002); forward it to a passthrough so the
          // audit-rollback assertions still hinge on the auditLogService mock.
          save: jest.fn((entity: unknown) => Promise.resolve(entity)),
        }),
      ),
    };

    mockTenantRoleService = {
      getRoleById: jest.fn().mockResolvedValue(createMockRoleWithDetails()),
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

    const adminAuthority: ActorAuthority = {
      isTenantAdmin: true,
      effective: new Set<string>(),
      entitled: new Set<string>(),
    };
    mockCapabilityAuthority = {
      resolveActorAuthority: jest.fn().mockResolvedValue(adminAuthority),
      assertGrantableOverrides: jest.fn((o: { grants?: string[]; revokes?: string[] } | null) => ({
        grants: o?.grants ?? [],
        revokes: o?.revokes ?? [],
      })),
      assertGrantableResourcePermissions: jest.fn((requested: string[]) => requested),
      emptyOverrides: jest.fn(() => ({ grants: [], revokes: [] })),
    };

    mockUserTokenRevocation = {
      revokeUserTokens: jest.fn().mockResolvedValue(undefined),
      isTokenValid: jest.fn().mockResolvedValue(true),
    };
    mockDurableInvalidation = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      applyImmediately: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantUserManagementService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
        { provide: getRepositoryToken(MobileUserSettings), useValue: mockMobileSettingsRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: TenantRoleService, useValue: mockTenantRoleService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: UserLifecycleService, useValue: mockUserLifecycleService },
        { provide: CapabilityAuthorityService, useValue: mockCapabilityAuthority },
        { provide: USER_TOKEN_REVOCATION, useValue: mockUserTokenRevocation },
        { provide: DurableUserTokenInvalidationService, useValue: mockDurableInvalidation },
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

      await expect(service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should propagate NotFoundException from UserLifecycleService', async () => {
      mockUserLifecycleService.createUser.mockRejectedValue(
        new NotFoundException('Tenant not found'),
      );

      await expect(service.createTenantUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        NotFoundException,
      );
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

    it('ORPHAN-CRITICAL-100 / FINDING #1: a TENANT_ADMIN of tenant A is denied on tenant B (null actor -> ceiling 0 -> Forbidden)', async () => {
      // assertRoleGrantAuthority pins the actor lookup to the acting tenant
      // (findOne where { id, tenantId }). A TENANT_ADMIN of tenant A invoking a
      // tenant-B mutation resolves to a NULL actor in tenant B, so the unbounded
      // SUPER_ADMIN/TENANT_ADMIN early-return is NOT taken — the call falls
      // through to the ceiling query, which returns no in-tenant assignment for
      // the foreign admin (ceiling 0), and any positive-level grant is denied.
      const targetUser = createMockUser({ id: USER_ID, tenantId: TENANT_ID });
      userRepository.findOne.mockImplementation((opts) => {
        const id = (opts as { where: { id: string; tenantId?: string } }).where.id;
        // The acting admin belongs to a DIFFERENT tenant, so the tenant-pinned
        // lookup for them in TENANT_ID returns null; the target resolves.
        if (id === USER_ID) {
          return Promise.resolve(targetUser);
        }
        return Promise.resolve(null); // foreign-tenant admin: no row in this tenant
      });
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ level: 30 }), // any positive-level role
      );
      // Ceiling query for the foreign admin returns no in-tenant assignment.
      mockDataSource.query.mockResolvedValueOnce([]); // ceiling -> 0

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(ForbiddenException);

      // Prove the actor lookup was tenant-pinned (the cross-tenant door is shut).
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: ADMIN_USER_ID, tenantId: TENANT_ID },
      });
      // Prove the ceiling query bound tenantId (auth.* JOIN, no interpolation).
      const [ceilingSql, ceilingParams] = mockDataSource.query.mock.calls[0] as [string, unknown[]];
      expect(ceilingSql).toContain('"auth"."user_role_assignments"');
      expect(ceilingSql).toContain('tr."tenantId" = $2');
      expect(ceilingParams).toEqual([ADMIN_USER_ID, TENANT_ID]);
    });

    it('ORPHAN-CRITICAL-100 / FINDING #5: an audit failure in the shared createRoleAssignment helper ROLLS BACK the INSERT (manager-threaded)', async () => {
      // The assignUserRole success path routes the INSERT through the shared
      // createRoleAssignment helper, which runs the INSERT...SELECT and its
      // USER_ROLE_CHANGED audit inside ONE transaction with `manager` threaded.
      // A throwing audit aborts the whole assignment (fail-CLOSED).
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing active assignment
        .mockResolvedValueOnce([{ id: 'new-assignment-id' }]); // INSERT...SELECT RETURNING id
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow('audit DB down');

      // The audit was invoked with the tx manager as the 2nd argument.
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_ROLE_CHANGED' }),
        expect.anything(),
      );
    });

    it('GLOBAL UNIQUE(user_id): re-assigning a user who already has an (inactive) row re-points via ON CONFLICT instead of a duplicate INSERT', async () => {
      // user_role_assignments has a GLOBAL unique index on user_id ALONE (not
      // partial on is_active). assignUserRole's active-check returns no ACTIVE
      // row (the user was previously revoked → is_active=false), so it proceeds
      // to createRoleAssignment. A plain INSERT would hit a 23505 unique
      // violation on the dormant inactive row; the upsert must re-point it.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query
        .mockResolvedValueOnce([]) // no ACTIVE assignment (the dormant row is inactive)
        .mockResolvedValueOnce([{ id: 'repointed-assignment-id' }]); // upsert RETURNING id

      const result = await service.assignUserRole(
        TENANT_ID,
        USER_ID,
        { roleId: ROLE_ID },
        ADMIN_USER_ID,
      );

      expect(result.id).toBe('repointed-assignment-id');
      expect(result.isActive).toBe(true);

      // The 2nd dataSource.query (forwarded by the tx mock) is the upsert: it
      // must carry ON CONFLICT (user_id) DO UPDATE and re-activate the row, so
      // the global UNIQUE(user_id) is structurally respected (no 23505).
      const [upsertSql] = mockDataSource.query.mock.calls[1] as [string, unknown[]];
      expect(upsertSql).toContain('INSERT INTO "auth"."user_role_assignments"');
      expect(upsertSql).toContain('ON CONFLICT (user_id) DO UPDATE');
      expect(upsertSql).toContain('is_active = true');
      // The tenant guard survives the upsert: the source is still the in-tenant
      // role SELECT, so a foreign-tenant role produces no candidate to upsert.
      expect(upsertSql).toContain('tr."tenantId" = $6');
      // GROUND-TRUTH: no updated_by anywhere in the assignment write.
      expect(upsertSql).not.toContain('updated_by');
    });

    it('ORPHAN-CRITICAL-100: a foreign-tenant roleId yields zero INSERT rows -> NotFoundException', async () => {
      // createRoleAssignment's INSERT...SELECT FROM "auth"."tenant_roles"
      // WHERE tr."tenantId" = $6 produces zero source rows for a role that does
      // not belong to the tenant, so RETURNING id is empty -> NotFoundException,
      // and no audit row is written.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(createMockRoleWithDetails());
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing active assignment
        .mockResolvedValueOnce([]); // INSERT...SELECT returns no row (role not in tenant)

      await expect(
        service.assignUserRole(TENANT_ID, USER_ID, { roleId: ROLE_ID }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
      expect(mockAuditLogService.log).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce([
          {
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
          },
        ]); // getUserRoleAssignment

      const newRole = createMockRoleWithDetails({ id: 'new-role-id', name: 'Supervisor' });
      mockTenantRoleService.getRoleById.mockResolvedValue(newRole);

      const result = await service.updateUserRole(
        TENANT_ID,
        USER_ID,
        { roleId: 'new-role-id' },
        ADMIN_USER_ID,
      );

      expect(result).toBeDefined();
      // Audit ran INSIDE the transaction (fail-closed). FINDING #5: the audit
      // log call now receives the tx `manager` as its SECOND argument so it
      // writes on the same connection (manager-threaded fail-CLOSED).
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
        }),
        expect.anything(),
      );
      // RBAC-HIGH-001: the change revokes the user's live tokens so the new
      // effective set is enforced on the next request (fleet-wide).
      expect(mockDurableInvalidation.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: USER_ID, invalidatedAt: expect.any(Date) }),
      );
      expect(mockDurableInvalidation.applyImmediately).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, invalidatedAt: expect.any(Date) }),
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
      // RBAC-C1: the override-only path now resolves the ceiling role (the user's
      // current role) so the authority guard runs even with no role change.
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: ROLE_ID }),
      );
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

    it('RBAC-C1: an override-ONLY update runs the grant-authority validator and a rejection aborts before any write', async () => {
      // The escalation was: updateUserRole with ONLY permissionOverrides skipped
      // the authority guard, letting a delegate self-grant anything. Now the
      // override grants are validated unconditionally; a rejection must abort
      // before the transaction.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockDataSource.query.mockResolvedValueOnce([
        { id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID },
      ]); // existing
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: ROLE_ID }),
      );
      mockCapabilityAuthority.assertGrantableOverrides.mockImplementation(() => {
        throw new ForbiddenException(
          'You cannot grant capabilities you do not hold: roles:delete.',
        );
      });

      await expect(
        service.updateUserRole(
          TENANT_ID,
          USER_ID,
          { permissionOverrides: { grants: ['roles:delete'], revokes: [] } },
          ADMIN_USER_ID,
        ),
      ).rejects.toThrow(ForbiddenException);
      // The validator was consulted, and no assignment write happened.
      expect(mockCapabilityAuthority.assertGrantableOverrides).toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // ORPHAN-CRITICAL-100 regression tests (Wave-5 repoint)
    // ------------------------------------------------------------------

    it('ORPHAN-CRITICAL-100: a cross-tenant assignmentId yields ZERO rows -> NotFoundException', async () => {
      // The existing-assignment fetch reads from "auth"."user_role_assignments"
      // JOINed to "auth"."tenant_roles" on tr."tenantId" = $2. An assignment
      // whose role belongs to a DIFFERENT tenant is filtered out by the JOIN, so
      // the SELECT returns 0 rows even though the bare user_role_assignments row
      // physically exists. No UPDATE, no transaction.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockDataSource.query.mockResolvedValueOnce([]); // JOIN filters out the foreign-tenant assignment

      await expect(
        service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID),
      ).rejects.toThrow(NotFoundException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();

      // Prove the read carried the bound tenant guard (no interpolated schema).
      const [sql, params] = mockDataSource.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('"auth"."user_role_assignments"');
      expect(sql).toContain('tr."tenantId" = $2');
      expect(params).toEqual([USER_ID, TENANT_ID]);
    });

    it('ORPHAN-CRITICAL-100 / FINDING #6: the role UPDATE binds id then tenantId with exact param indices', async () => {
      // Param-index discipline: assignmentId is pushed FIRST, tenantId SECOND.
      // An off-by-one would drop the tr."tenantId" guard — assert the WHERE binds
      // the LAST two positional params to ura.id and tr."tenantId" respectively,
      // and that those values are the assignmentId and the tenantId.
      const adminActor = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminActor);
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID, user_id: USER_ID }]) // existing
        .mockResolvedValueOnce([]) // UPDATE (inside tx)
        .mockResolvedValueOnce([
          {
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
          },
        ]); // getUserRoleAssignment
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id', name: 'Supervisor' }),
      );

      await service.updateUserRole(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID);

      // The UPDATE is the 2nd dataSource.query call (forwarded by the tx mock).
      const [updateSql, updateParams] = mockDataSource.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('UPDATE "auth"."user_role_assignments" ura');
      expect(updateSql).toContain('FROM "auth"."tenant_roles" tr');
      // GROUND-TRUTH: no updated_by column on user_role_assignments — the
      // dynamic UPDATE must never emit it (would fail at runtime).
      expect(updateSql).not.toContain('updated_by');
      expect(updateSql).toContain('updated_at = NOW()');
      // The penultimate param is the assignmentId (ura.id), the last is tenantId.
      const idIdxMatch = /ura\.id = \$(\d+)/.exec(updateSql);
      const tenantIdxMatch = /tr\."tenantId" = \$(\d+)/.exec(updateSql);
      expect(idIdxMatch).not.toBeNull();
      expect(tenantIdxMatch).not.toBeNull();
      const idIdx = Number(idIdxMatch?.[1]);
      const tenantIdx = Number(tenantIdxMatch?.[1]);
      // tenantId index is exactly one past the assignmentId index (off-by-one guard).
      expect(tenantIdx).toBe(idIdx + 1);
      expect(updateParams[idIdx - 1]).toBe('assignment-1');
      expect(updateParams[tenantIdx - 1]).toBe(TENANT_ID);
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

      await service.updateTenantUser(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID);

      expect(mockDataSource.transaction).toHaveBeenCalled();
      // GROUND-TRUTH: the role-change UPDATE (2nd query, forwarded by the tx
      // mock) carries NO updated_by column — it sets only role_id + updated_at.
      const [updateSql, updateParams] = mockDataSource.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('UPDATE "auth"."user_role_assignments" ura');
      expect(updateSql).not.toContain('updated_by');
      expect(updateSql).toContain('SET role_id = $1, updated_at = NOW()');
      // No actor param on the assignment write; params are [roleId, id, tenantId].
      expect(updateParams).toEqual(['new-role-id', 'a1', TENANT_ID]);
      // FINDING #5: audit log is manager-threaded (2nd arg) — fail-CLOSED.
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
          previousValue: { roleId: ROLE_ID },
          newValue: { roleId: 'new-role-id' },
        }),
        expect.anything(),
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
      // D1 #3: the no-existing branch now routes through the shared
      // createRoleAssignment helper. Its INSERT...SELECT RETURNING id returns a
      // row only when the role belongs to the tenant — mock that row.
      userRepository.findOne.mockResolvedValue(createMockUser({ role: Role.TENANT_ADMIN }));
      mockTenantRoleService.getRoleById.mockResolvedValue(
        createMockRoleWithDetails({ id: 'new-role-id' }),
      );
      mockDataSource.query
        .mockResolvedValueOnce([]) // no existing assignment (auth.* JOIN read)
        .mockResolvedValueOnce([{ id: 'new-assignment-id' }]); // INSERT...SELECT RETURNING id

      await service.updateTenantUser(TENANT_ID, USER_ID, { roleId: 'new-role-id' }, ADMIN_USER_ID);

      expect(mockDataSource.transaction).toHaveBeenCalled();
      // The shared helper logs USER_ROLE_CHANGED with previousValue.roleId=null
      // and the manager threaded as the 2nd arg (atomic / fail-CLOSED).
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          previousValue: { roleId: null },
          newValue: { roleId: 'new-role-id' },
        }),
        expect.anything(),
      );
    });

    it('allows a profile-only update on self without the role guard or a transaction', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());

      await service.updateTenantUser(TENANT_ID, USER_ID, { firstName: 'Renamed' }, USER_ID);

      expect(userRepository.save).not.toHaveBeenCalled();
      expect(userRepository.update).toHaveBeenCalledWith(
        { id: USER_ID, tenantId: TENANT_ID },
        { firstName: 'Renamed' },
      );
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(mockAuditLogService.log).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // deleteTenantUser — D1 (Wave-5): fail-closed soft-delete audit
  // ==========================================================================

  describe('deleteTenantUser', () => {
    it('RBAC-HIGH-002: delegates to the single deletion SSoT (UserLifecycleService.deleteUser)', async () => {
      // The deletion logic (soft-delete + role revoke + refresh-token revoke +
      // access-token revoke + fail-closed audit) lives in ONE place and is tested
      // there; this facade must NOT re-implement it (that divergent copy skipped
      // refresh-token revocation). Assert pure delegation, no local transaction.
      const result = await service.deleteTenantUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockUserLifecycleService.deleteUser).toHaveBeenCalledWith(
        TENANT_ID,
        USER_ID,
        ADMIN_USER_ID,
      );
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // revokeUserRole
  // ==========================================================================

  describe('revokeUserRole', () => {
    it('should soft-delete role assignment by default', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID }]) // existing active
        .mockResolvedValueOnce([]); // UPDATE is_active = false (inside tx)

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
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID }])
        .mockResolvedValueOnce([]); // DELETE (inside tx)

      const result = await service.revokeUserRole(TENANT_ID, USER_ID, true, ADMIN_USER_ID);

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('DELETE'),
        expect.any(Array),
      );
    });

    it('GROUND-TRUTH: the revoke write carries NO updated_by column', async () => {
      // user_role_assignments has no updated_by column; writing it fails at
      // runtime. The soft-delete UPDATE must set only is_active + updated_at.
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID }]) // existing active
        .mockResolvedValueOnce([]); // UPDATE (inside tx)

      await service.revokeUserRole(TENANT_ID, USER_ID, false, ADMIN_USER_ID);

      const [updateSql, updateParams] = mockDataSource.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).not.toContain('updated_by');
      expect(updateSql).toContain('updated_at = NOW()');
      // No actor param is bound on the assignment write; the WHERE binds only
      // userId + tenantId (the actor lives in the audit row, not the table).
      expect(updateParams).toEqual([USER_ID, TENANT_ID]);
    });

    it('records the revoke actor in a manager-threaded USER_ROLE_CHANGED audit', async () => {
      // GROUND-TRUTH: no updated_by column → the revoking actor (revokedBy) is
      // the durable record IN the audit log (performedBy), threaded `manager` so
      // it commits atomically with the revoke write (fail-CLOSED).
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID }]) // existing active
        .mockResolvedValueOnce([]); // UPDATE (inside tx)

      await service.revokeUserRole(TENANT_ID, USER_ID, false, ADMIN_USER_ID);

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: USER_ID,
          performedBy: ADMIN_USER_ID,
          previousValue: { roleId: ROLE_ID, isActive: true },
          newValue: { roleId: null, isActive: false, hardDelete: false },
        }),
        expect.anything(),
      );
    });

    it('rolls back the revoke when the audit fails (fail-CLOSED)', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query
        .mockResolvedValueOnce([{ id: 'assignment-1', role_id: ROLE_ID }]) // existing active
        .mockResolvedValueOnce([]); // UPDATE (inside tx)
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(
        service.revokeUserRole(TENANT_ID, USER_ID, false, ADMIN_USER_ID),
      ).rejects.toThrow('audit DB down');
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
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // getUserEffectivePermissions
  // ==========================================================================

  describe('getUserEffectivePermissions', () => {
    it('should return effective permissions for a user with active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([
        {
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
        },
      ]);

      const result = await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(result.roleId).toBe(ROLE_ID);
      expect(result.roleName).toBe('Operator');
      expect(result.resourcePermissions).toEqual(['sites:view', 'sensors:view']);
      expect(result.overrides.grants).toEqual(['sensors:configure']);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getUserEffectivePermissions(TENANT_ID, 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when no active assignment', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([]); // no active assignment

      await expect(service.getUserEffectivePermissions(TENANT_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should handle null permission_overrides gracefully', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([
        {
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
        },
      ]);

      const result = await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(result.overrides).toEqual({ grants: [], revokes: [] });
      expect(result.panelPermissions).toEqual({});
    });

    it('should handle string-formatted permission_overrides', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDataSource.query.mockResolvedValueOnce([
        {
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
        },
      ]);

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
      userRepository.findOne.mockImplementation((opts) =>
        Promise.resolve(usersById[(opts as { where: { id: string } }).where.id] ?? null),
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
      mockDataSource.query.mockResolvedValue([
        {
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
        },
      ]);

      await service.getUserEffectivePermissions(TENANT_ID, USER_ID);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID, tenantId: TENANT_ID },
      });
    });

    it('ORPHAN-CRITICAL-100: queries the auth schema with tenantId bound (never interpolated)', async () => {
      const otherTenantId = '22222222-2222-2222-2222-222222222222';

      userRepository.findOne.mockResolvedValue(createMockUser({ tenantId: otherTenantId }));
      mockDataSource.query.mockResolvedValue([
        {
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
        },
      ]);

      await service.getUserEffectivePermissions(otherTenantId, USER_ID);

      // The repoint reads from the shared auth schema; the tenant is enforced by
      // the tenant_roles JOIN with tenantId as a BOUND parameter ($2), never by
      // string-interpolating a tenant_<uuid> schema name into the SQL.
      const [sql, params] = mockDataSource.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('"auth"."user_role_assignments"');
      expect(sql).toContain('"auth"."tenant_roles"');
      expect(sql).toContain('r."tenantId" = $2');
      expect(sql).not.toContain('tenant_22222222');
      expect(params).toEqual([USER_ID, otherTenantId]);
    });
  });
});
