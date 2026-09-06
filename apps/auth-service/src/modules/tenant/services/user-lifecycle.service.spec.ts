import { Role } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UserInvitedEvent } from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { ActionToken } from '../../authentication/entities/action-token.entity';
import { Invitation } from '../../authentication/entities/invitation.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { DurableUserTokenInvalidationService } from '../../authentication/services/durable-user-token-invalidation.service';
import { MobileUserSettings } from '../entities/mobile-user-settings.entity';
import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';

import { CapabilityAuthorityService } from './capability-authority';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';
import { UserLifecycleService } from './user-lifecycle.service';

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
  findOneByOrFail: jest.Mock;
  findAndCount: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
} => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneByOrFail: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn(<T>(data: T) => ({ ...data })),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  })),
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
  let mockTenantRoleService: jest.Mocked<Pick<TenantRoleService, 'getRoleById'>>;
  let mockEventBus: { publish: jest.Mock<Promise<void>, [UserInvitedEvent]> };
  let mockAuditLogService: { log: jest.Mock };
  let mockDurableUserTokenInvalidation: {
    enqueue: jest.Mock;
    applyImmediately: jest.Mock;
  };
  // The manager the default transaction() mock handed to the service last —
  // createUser tests read the Invitation/ActionToken writes back off it.
  let lastTransactionManager: { save: jest.Mock } | null = null;

  beforeEach(async () => {
    lastTransactionManager = null;
    mockDurableUserTokenInvalidation = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      applyImmediately: jest.fn().mockResolvedValue(undefined),
    };
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();
    mockTenantRepo.findOne.mockResolvedValue(createMockTenant());
    mockUserRepo.findOneByOrFail.mockImplementation(async (where: unknown) => {
      const user: User | null = await mockUserRepo.findOne({ where });
      if (!user) throw new NotFoundException('User not found');
      return user;
    });
    mockUserRepo.update.mockImplementation(async (criteria: unknown, values: Partial<User>) => {
      const current: User | null = await mockUserRepo.findOne({ where: criteria });
      if (!current) throw new NotFoundException('User not found');
      const updated = Object.assign(new User(), current, values);
      mockUserRepo.findOne.mockResolvedValue(updated);
      return { affected: 1, raw: [], generatedMaps: [] };
    });
    const mockRefreshTokenRepo = createMockRepository();
    mockRefreshTokenRepo.count.mockResolvedValue(1);
    mockRefreshTokenRepo.update.mockResolvedValue({
      affected: 1,
      raw: [],
      generatedMaps: [],
    });
    // WHY: UserLifecycleService grew four repositories — MobileUserSettings
    // (accessType-driven mobile provisioning), Invitation and
    // UserModuleAssignment (atomic invite + module assignment), and
    // ActionToken (opaque invitation token ledger) — so the testing
    // module must mirror the production constructor exactly.
    const mockMobileSettingsRepo = createMockRepository();
    const mockInvitationRepo = createMockRepository();
    const mockActionTokenRepo = createMockRepository();
    const mockUserModuleAssignmentRepo = createMockRepository();

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation((cb: (manager: unknown) => Promise<unknown>) => {
        // Simulate transaction by passing a mock manager
        const mockManager = {
          queryRunner: { isTransactionActive: true },
          findOne: jest.fn((entity: unknown, options: unknown) => {
            if (entity === User) return mockUserRepo.findOne(options);
            if (entity === Tenant) return mockTenantRepo.findOne(options);
            throw new Error('Unexpected lifecycle identity lookup');
          }),
          findOneByOrFail: jest.fn(() => mockUserRepo.findOneByOrFail()),
          count: jest.fn().mockResolvedValue(5),
          getRepository: jest.fn().mockReturnValue(mockUserRepo),
          withRepository: jest.fn((repository: unknown) => repository),
          // createUser writes its User row through the transactional manager
          // (SEC-HIGH-158: user + invitation + action token commit together);
          // route the User shape to the injected repo mock so userRepository
          // assertions still observe the write.
          create: jest.fn(<T>(entity: unknown, data: T) =>
            entity === User ? mockUserRepo.create(data) : { ...data },
          ),
          // Three save shapes: save(User, data) (createUser), save(Entity, data)
          // (Invitation / ActionToken rows minted by createUser) and save(entity)
          // (deleteUser soft-delete). The User and 1-arg forms delegate to the
          // user repo mock so userRepository.save assertions still observe them.
          save: jest.fn((entityOrData: unknown, data?: Record<string, unknown>) => {
            if (data === undefined) return mockUserRepo.save(entityOrData);
            if (entityOrData === User) return mockUserRepo.save(data);
            if (entityOrData === Invitation)
              return Promise.resolve({ id: 'invitation-id', ...data });
            return Promise.resolve({ id: 'action-token-id', ...data });
          }),
          // SEC-MEDIUM-002: deleteUser revokes refresh tokens via
          // manager.update(RefreshToken, ...) inside the transaction; route it to
          // the injected refresh-token repo mock so refreshTokenRepository.update
          // assertions still observe the call.
          update: jest.fn((entity: unknown, criteria: unknown, partial: unknown) =>
            entity === RefreshToken
              ? mockRefreshTokenRepo.update(criteria, partial)
              : mockUserRepo.update(criteria, partial),
          ),
          createQueryBuilder: jest.fn(() => createMockTenantCounterBuilder()),
          query: mockDataSource.query,
        };
        lastTransactionManager = mockManager;
        return cb(mockManager);
      }),
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
        { provide: getRepositoryToken(ActionToken), useValue: mockActionTokenRepo },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: mockUserModuleAssignmentRepo,
        },
        { provide: DataSource, useValue: mockDataSource },
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
        {
          // RBAC-C1/C2: default mock behaves as an admin creator (grants pass
          // through). createUser now routes override grants through this SSoT.
          provide: CapabilityAuthorityService,
          useValue: {
            resolveActorAuthority: jest.fn().mockResolvedValue({
              isTenantAdmin: true,
              effective: new Set<string>(),
              entitled: new Set<string>(),
            }),
            assertGrantableOverrides: jest.fn(
              (o: { grants?: string[]; revokes?: string[] } | null) => ({
                grants: o?.grants ?? [],
                revokes: o?.revokes ?? [],
              }),
            ),
            assertGrantableResourcePermissions: jest.fn((requested: string[]) => requested),
            emptyOverrides: jest.fn(() => ({ grants: [], revokes: [] })),
          },
        },
        {
          provide: DurableUserTokenInvalidationService,
          useValue: mockDurableUserTokenInvalidation,
        },
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

  function setUserAndAuditActor(user: User, actor: User): void {
    let currentUser = user;
    userRepository.findOne.mockImplementation(async (options) => {
      const where = options.where;
      if (!where || Array.isArray(where)) throw new Error('Expected an identity lookup');
      if (where.tenantId && where.tenantId !== TENANT_ID) return null;
      if (where.id === ADMIN_USER_ID) return actor;
      return where.id === currentUser.id ? currentUser : null;
    });
    userRepository.update.mockImplementation(async (_criteria, values) => {
      currentUser = Object.assign(new User(), currentUser, values);
      return { affected: 1, raw: [], generatedMaps: [] };
    });
  }

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

    // The transactional manager is created per transaction() call; read the
    // entity-tagged save calls back off the manager the service was handed.
    const managerSaves = (entity: unknown): Record<string, unknown>[] => {
      if (lastTransactionManager === null) {
        throw new Error('createUser did not open a transaction');
      }
      return lastTransactionManager.save.mock.calls
        .filter((call: unknown[]) => call[0] === entity)
        .map((call: unknown[]) => call[1] as Record<string, unknown>);
    };
    const invitationSaves = (): Record<string, unknown>[] => managerSaves(Invitation);
    const actionTokenSaves = (): Record<string, unknown>[] => managerSaves(ActionToken);

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

    // SEC-HIGH-158: the e-mailed link names an ActionToken ROW ID. Before this
    // fix createUser wrote no Invitation/ActionToken row at all and published a
    // token HASH under `actionTokenId`, so the notification service could never
    // resolve the row and the invitee's link was dead on arrival.
    it('SEC-HIGH-158: mints Invitation + ActionToken in the user transaction and publishes the row id', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      const savedUser = createMockUser({ email: 'newuser@tenant.com' });
      userRepository.save.mockResolvedValue(savedUser);
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createUser(TENANT_ID, createInput, ADMIN_USER_ID);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      const [txCallback] = mockDataSource.transaction.mock.calls[0] ?? [];
      expect(typeof txCallback).toBe('function');
      const userWrite = userRepository.create.mock.calls[0]?.[0];
      expect(userWrite).toEqual(
        expect.objectContaining({
          invitationToken: expect.stringMatching(/^[0-9a-f]{64}$/),
          invitationExpiresAt: expect.any(Date),
        }),
      );
      // The Invitation and ActionToken rows share the user's token hash.
      const invitationRow = invitationSaves()[0];
      const actionTokenRow = actionTokenSaves()[0];
      expect(invitationRow).toEqual(
        expect.objectContaining({
          token: userWrite?.invitationToken,
          tenantId: TENANT_ID,
          email: 'newuser@tenant.com',
          role: Role.MODULE_USER,
          invitedBy: ADMIN_USER_ID,
          sendCount: 1,
        }),
      );
      expect(actionTokenRow).toEqual(
        expect.objectContaining({
          purpose: 'INVITATION',
          tenantId: TENANT_ID,
          userId: USER_ID,
          tokenHash: userWrite?.invitationToken,
          status: 'ACTIVE',
          auditMetadata: { source: 'tenant-user-create', invitedBy: ADMIN_USER_ID },
        }),
      );
      expect(result.invitationSent).toBe(true);
      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      const [publishedEvent] = mockEventBus.publish.mock.calls[0] ?? [];
      expect(publishedEvent).toEqual(
        expect.objectContaining({
          eventType: 'UserInvited',
          tenantId: TENANT_ID,
          userId: USER_ID,
          invitedBy: ADMIN_USER_ID,
          credentialType: 'reset_token',
          actionTokenId: 'action-token-id',
          cryptoShredKeyId: USER_ID,
        }),
      );
      expect(publishedEvent?.actionTokenId).not.toBe(userWrite?.invitationToken);
      expect(JSON.stringify(publishedEvent)).not.toContain('newuser@tenant.com');
    });

    it('SEC-HIGH-158: a password-created user gets no invitation rows and no UserInvited', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser({ email: 'newuser@tenant.com' }));
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createUser(
        TENANT_ID,
        { ...createInput, password: 'Str0ng!Passw0rd' },
        ADMIN_USER_ID,
      );

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ invitationToken: null, invitationExpiresAt: null }),
      );
      expect(invitationSaves()).toHaveLength(0);
      expect(actionTokenSaves()).toHaveLength(0);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
      expect(result.invitationSent).toBe(false);
    });

    it('SEC-HIGH-158: sendInvitation=false mints nothing and publishes nothing', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser({ email: 'newuser@tenant.com' }));
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      const result = await service.createUser(TENANT_ID, createInput, ADMIN_USER_ID, false);

      expect(invitationSaves()).toHaveLength(0);
      expect(actionTokenSaves()).toHaveLength(0);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
      expect(result.invitationSent).toBe(false);
    });

    it('should throw ConflictException for duplicate email', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(createMockUser());

      await expect(service.createUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when tenant does not exist', async () => {
      tenantRepository.findOne.mockResolvedValue(null);

      await expect(service.createUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when role does not exist', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      mockTenantRoleService.getRoleById.mockResolvedValue(null);

      await expect(service.createUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    // ORPHAN-CRITICAL-100: the role-assignment write (private createRoleAssignment)
    // must target "auth"."user_role_assignments" via an INSERT...SELECT sourced
    // from "auth"."tenant_roles" tr WHERE tr.id=$2 AND tr."tenantId"=$6 — the
    // write's own tenant-ownership guard — handle the GLOBAL UNIQUE(user_id) via
    // ON CONFLICT (user_id) DO UPDATE, and use only GROUND-TRUTH columns.
    it('ORPHAN-CRITICAL-100: createRoleAssignment INSERT...SELECTs from "auth"."tenant_roles", ON CONFLICT(user_id), bound tenantId, GROUND-TRUTH columns only', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser({ email: 'newuser@tenant.com' }));
      mockDataSource.query.mockResolvedValueOnce([{ id: 'assignment-001' }]);

      await service.createUser(TENANT_ID, createInput, ADMIN_USER_ID);

      const insertCall = mockDataSource.query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('INSERT INTO') &&
          sql.includes('user_role_assignments'),
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall as [string, unknown[]];

      // Literal auth.* qualification, never an interpolated tenant schema.
      expect(sql).toContain('"auth"."user_role_assignments"');
      expect(sql).toContain('FROM "auth"."tenant_roles" tr');
      // No interpolated per-tenant "tenant_<uuid>" schema (the only legitimate
      // "tenant_" token is the auth.tenant_roles TABLE, not a SCHEMA prefix).
      expect(sql).not.toMatch(/"tenant_[0-9a-f]/i);
      // Write-side tenant-ownership guard.
      expect(sql).toContain('tr.id = $2');
      expect(sql).toContain('tr."tenantId" = $6');
      // Global UNIQUE(user_id) reconciliation.
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
      // Banned (non-existent) columns must NOT appear.
      expect(sql).not.toContain('updated_by');
      expect(sql).not.toContain('removed_by');
      expect(sql).not.toContain('removed_at');
      // tenantId bound as $6 (last positional param), roleId as $2.
      expect(params).toEqual([
        USER_ID,
        ROLE_ID,
        JSON.stringify({ grants: [], revokes: [] }),
        null,
        ADMIN_USER_ID,
        TENANT_ID,
      ]);
    });

    // ORPHAN-CRITICAL-100: a roleId not owned by the tenant yields 0 source rows
    // from the INSERT...SELECT → 0 rows RETURNING → tenant-scoped NotFoundException
    // (fail loud), NOT a silent undefined id.
    it('ORPHAN-CRITICAL-100: createRoleAssignment throws NotFoundException when the INSERT...SELECT returns no row (foreign-tenant role)', async () => {
      tenantRepository.findOne.mockResolvedValue(createMockTenant());
      userRepository.findOne.mockResolvedValue(null);
      userRepository.save.mockResolvedValue(createMockUser({ email: 'newuser@tenant.com' }));
      // INSERT...SELECT source empty → RETURNING yields no row.
      mockDataSource.query.mockResolvedValueOnce([]);

      await expect(service.createUser(TENANT_ID, createInput, ADMIN_USER_ID)).rejects.toThrow(
        NotFoundException,
      );
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
        .mockResolvedValueOnce(
          createMockUser({
            id: ADMIN_USER_ID,
            role: Role.TENANT_ADMIN,
            tenantId: TENANT_ID,
          }),
        )
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
        findOne: jest.fn().mockResolvedValue(createMockTenant()),
        count: jest.fn().mockResolvedValue(5),
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
      mockDataSource.transaction.mockImplementationOnce(async (...args: unknown[]) => {
        const cb = args.find(
          (arg): arg is (manager: unknown) => Promise<unknown> => typeof arg === 'function',
        );
        if (!cb) throw new Error('Missing transaction callback');
        return cb(txManager);
      });

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
        .mockResolvedValueOnce(
          createMockUser({
            id: ADMIN_USER_ID,
            role: Role.TENANT_ADMIN,
            tenantId: TENANT_ID,
          }),
        )
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
        findOne: jest.fn().mockResolvedValue(createMockTenant()),
        count: jest.fn().mockResolvedValue(5),
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
      mockDataSource.transaction.mockImplementationOnce(async (...args: unknown[]) => {
        const cb = args.find(
          (arg): arg is (manager: unknown) => Promise<unknown> => typeof arg === 'function',
        );
        if (!cb) throw new Error('Missing transaction callback');
        return cb(txManager);
      });

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
  // Credential-wide admin mutations
  // ==========================================================================

  describe('credential-wide admin mutations', () => {
    it('routes generic admin-api deactivation through the canonical credential fence', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      userRepository.save.mockResolvedValue(user);

      await expect(service.adminUpdateUser(USER_ID, { isActive: false })).resolves.toMatchObject({
        id: USER_ID, isActive: false,
      });

      expect((await userRepository.findOneByOrFail({ id: USER_ID })).isActive).toBe(false);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(userRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        refreshTokenRepository.createQueryBuilder.mock.invocationCallOrder[0]!,
      );
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: USER_ID },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: 'User authorization updated by administrator',
        }),
      );
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: USER_ID,
          tenantId: TENANT_ID,
          reason: 'logout_all_devices',
        }),
      );
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    });

    it('invalidates credentials when a generic admin update changes authorization claims', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      userRepository.save.mockResolvedValue(user);

      const updated = await service.adminUpdateUser(USER_ID, {
        role: Role.MODULE_MANAGER,
      });

      expect(updated.role).toBe(Role.MODULE_MANAGER);
      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    });

    it('keeps profile-only admin updates out of the credential revocation transaction', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      userRepository.save.mockResolvedValue(user);

      const updated = await service.adminUpdateUser(USER_ID, { firstName: 'Renamed' });

      expect(updated.firstName).toBe('Renamed');
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
      expect(mockDurableUserTokenInvalidation.enqueue).not.toHaveBeenCalled();
    });

    it('serializes admin password reset as User lock -> RefreshToken lock/update -> durable intent', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);

      const result = await service.adminResetPassword(USER_ID, 'NewPassword1!');

      expect(result).toEqual({ userId: USER_ID, refreshTokensRevoked: 1 });
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(userRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        refreshTokenRepository.createQueryBuilder.mock.invocationCallOrder[0]!,
      );
      expect(refreshTokenRepository.createQueryBuilder.mock.invocationCallOrder[0]).toBeLessThan(
        refreshTokenRepository.update.mock.invocationCallOrder[0]!,
      );
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: USER_ID,
          tenantId: TENANT_ID,
          reason: 'password_reset',
        }),
      );
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
    });

    it('uses the same credential fence for platform deactivation and force logout', async () => {
      const deactivatedUser = createMockUser();
      userRepository.findOne.mockResolvedValue(deactivatedUser);

      await expect(service.adminDeactivateUser(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        refreshTokensRemoved: 1,
      });

      expect((await userRepository.findOneByOrFail({ id: USER_ID })).isActive).toBe(false);
      expect(refreshTokenRepository.update).toHaveBeenLastCalledWith(
        { userId: USER_ID },
        expect.objectContaining({ isRevoked: true }),
      );
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'logout_all_devices' }),
      );

      jest.clearAllMocks();
      refreshTokenRepository.update.mockResolvedValue({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      const activeUser = createMockUser();
      userRepository.findOne.mockResolvedValue(activeUser);
      mockDurableUserTokenInvalidation.enqueue.mockResolvedValue(undefined);
      mockDurableUserTokenInvalidation.applyImmediately.mockResolvedValue(undefined);

      await expect(service.adminForceLogout(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        sessionsInvalidated: 1,
      });
      expect(activeUser.isActive).toBe(true);
      expect(refreshTokenRepository.delete).not.toHaveBeenCalled();
      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does not touch RefreshToken until the canonical User lock resolves', async () => {
      const user = createMockUser();
      let releaseUserLock: ((user: User) => void) | undefined;
      let signalLockRequested: (() => void) | undefined;
      const lockRequested = new Promise<void>((resolve) => { signalLockRequested = resolve; });
      const lockedUser = new Promise<User>((resolve) => { releaseUserLock = resolve; });
      userRepository.findOne.mockImplementation(async (options) => {
        if (options.lock) {
          if (!signalLockRequested) throw new Error('User lock observer is unavailable');
          signalLockRequested();
          return lockedUser;
        }
        return user;
      });

      const operation = service.adminForceLogout(USER_ID);
      await lockRequested;

      expect(refreshTokenRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();

      if (!releaseUserLock) {
        throw new Error('User-lock test gate was not initialized');
      }
      releaseUserLock(user);
      await operation;

      expect(refreshTokenRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(refreshTokenRepository.update).toHaveBeenCalledTimes(1);
    });

    it('fails closed before commit when durable invalidation cannot be enqueued', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDurableUserTokenInvalidation.enqueue.mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      await expect(service.adminResetPassword(USER_ID, 'NewPassword1!')).rejects.toThrow(
        'outbox unavailable',
      );

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
    });

    it('keeps committed revocation successful when immediate Redis application fails', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDurableUserTokenInvalidation.applyImmediately.mockRejectedValueOnce(
        new Error('redis unavailable'),
      );

      await expect(service.adminForceLogout(USER_ID)).resolves.toEqual({
        userId: USER_ID,
        sessionsInvalidated: 1,
      });

      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
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
      expect(userRepository.save).not.toHaveBeenCalled();
      expect(userRepository.update).toHaveBeenCalledWith(
        { id: USER_ID }, expect.objectContaining({ isActive: false }),
      );
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(userRepository.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        refreshTokenRepository.createQueryBuilder.mock.invocationCallOrder[0]!,
      );

      // 2. CRITICAL: Refresh tokens must be revoked
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: USER_ID },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: expect.stringContaining('deleted') as string,
        }),
      );

      // 3. The access-token invalidation intent commits durably with the
      // credential mutation, then the low-latency Redis epoch is applied.
      expect(mockDurableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ withRepository: expect.any(Function) }),
        expect.objectContaining({
          userId: USER_ID,
          tenantId: TENANT_ID,
          reason: 'logout_all_devices',
        }),
      );
      expect(mockDurableUserTokenInvalidation.applyImmediately).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID }),
      );
    });

    it('should prevent self-deletion', async () => {
      await expect(service.deleteUser(TENANT_ID, ADMIN_USER_ID, ADMIN_USER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should prevent deleting another TENANT_ADMIN', async () => {
      const adminUser = createMockUser({ role: Role.TENANT_ADMIN });
      userRepository.findOne.mockResolvedValue(adminUser);

      await expect(service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
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

      // Should query the role-assignments table to revoke role assignments
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('user_role_assignments'),
        expect.arrayContaining([USER_ID]),
      );
    });

    // ORPHAN-CRITICAL-100: the role-revoke UPDATE must target the shared
    // "auth"."user_role_assignments" table (NOT an interpolated per-tenant
    // "tenant_<uuid>" schema), launder tenant ownership through a write-side
    // FROM-join to "auth"."tenant_roles" with tenantId BOUND, and must NOT
    // reference the non-existent `updated_by` column.
    it('ORPHAN-CRITICAL-100: role-revoke targets "auth"."user_role_assignments" with a tenant-guarded FROM-join, no updated_by, tenantId bound', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      const revokeCall = mockDataSource.query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('UPDATE') &&
          sql.includes('user_role_assignments'),
      );
      expect(revokeCall).toBeDefined();
      const [sql, params] = revokeCall as [string, unknown[]];

      // Literal auth.* qualification — never the interpolated tenant schema.
      expect(sql).toContain('"auth"."user_role_assignments"');
      expect(sql).toContain('"auth"."tenant_roles"');
      // No interpolated per-tenant "tenant_<uuid>" schema (the only legitimate
      // "tenant_" token is the auth.tenant_roles TABLE, not a SCHEMA prefix).
      expect(sql).not.toMatch(/"tenant_[0-9a-f]/i);
      // Write-side tenant guard through the role JOIN.
      expect(sql).toContain('tr."tenantId" = $2');
      expect(sql).toContain('tr.id = ura.role_id');
      // `updated_by` is NOT a real column — must be absent.
      expect(sql).not.toContain('updated_by');
      // Only GROUND-TRUTH mutation columns.
      expect(sql).toContain('is_active = false');
      expect(sql).toContain('updated_at = NOW()');
      // tenantId is a bound param, never deletedBy (no updated_by anymore).
      expect(params).toEqual([USER_ID, TENANT_ID]);
    });

    it('should log audit event for user deletion', async () => {
      const user = createMockUser();
      setUserAndAuditActor(user, createMockUser({ id: ADMIN_USER_ID, email: 'admin@tenant.com' }));

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      // ORPHAN-CRITICAL-100: the audit `log()` MUST be passed the enclosing
      // transaction's `manager` as the 2nd arg (fail-CLOSED — audit row is
      // atomic with the soft-delete + role revoke + token revoke).
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_DELETED',
          entityId: USER_ID,
        }),
        expect.objectContaining({ getRepository: expect.any(Function) }),
      );
    });

    // ORPHAN-CRITICAL-100: the admin (actor) lookup that supplies
    // `performedByEmail` must be pinned to the tenant so a cross-tenant
    // `deletedBy` id cannot leak a foreign tenant's admin email into THIS
    // tenant's audit row.
    it('ORPHAN-CRITICAL-100: admin lookup is pinned to tenantId (no foreign-actor email leak)', async () => {
      const user = createMockUser();
      setUserAndAuditActor(user, createMockUser({ id: ADMIN_USER_ID, email: 'admin@tenant.com' }));

      await service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: ADMIN_USER_ID, tenantId: TENANT_ID },
      });
    });

    it('SEC-MEDIUM-002: an audit failure ROLLS BACK the soft-delete (fail-closed)', async () => {
      // Previously the soft-delete + token revoke committed first and the audit
      // ran in a swallowed try/catch (fail-OPEN) — a deletion could persist with
      // no audit evidence. The whole soft-delete now runs inside one
      // transaction, so a throwing audit aborts it.
      setUserAndAuditActor(createMockUser(), createMockUser({ id: ADMIN_USER_ID }));
      mockAuditLogService.log.mockRejectedValueOnce(new Error('audit DB down'));

      await expect(service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID)).rejects.toThrow(
        'audit DB down',
      );
    });

    it('fails closed before commit when durable deletion invalidation cannot be enqueued', async () => {
      userRepository.findOne.mockResolvedValue(createMockUser());
      mockDurableUserTokenInvalidation.enqueue.mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      await expect(service.deleteUser(TENANT_ID, USER_ID, ADMIN_USER_ID)).rejects.toThrow(
        'outbox unavailable',
      );

      expect(mockAuditLogService.log).not.toHaveBeenCalled();
      expect(mockDurableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
    });
  });
});
