import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { UserSiteAssignment } from '../../authentication/entities/user-site-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { TenantAdminService } from '../services/tenant-admin.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SUPER_ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_SITE_ID = '33333333-3333-4333-8333-333333333334';
const ASSIGNMENT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-08-01T12:00:00.000Z');

interface FixtureOptions {
  actor?: User | null;
  target?: User | null;
  existingAssignment?: UserSiteAssignment | null;
  assignmentCandidates?: UserSiteAssignment[];
}

function makeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: TARGET_USER_ID,
    tenantId: TENANT_ID,
    email: 'target@example.test',
    role: Role.MODULE_USER,
    isActive: true,
    ...overrides,
  });
}

function makeAssignment(overrides: Partial<UserSiteAssignment> = {}): UserSiteAssignment {
  return Object.assign(new UserSiteAssignment(), {
    id: ASSIGNMENT_ID,
    userId: TARGET_USER_ID,
    siteId: SITE_ID,
    tenantId: TENANT_ID,
    isActive: true,
    assignedBy: ADMIN_ID,
    expiresAt: null,
    ...overrides,
  });
}

function makeFixture(options: FixtureOptions = {}) {
  const actor = Object.prototype.hasOwnProperty.call(options, 'actor')
    ? (options.actor ?? null)
    : makeUser({
        id: ADMIN_ID,
        email: 'admin@example.test',
        role: Role.TENANT_ADMIN,
      });
  const target = Object.prototype.hasOwnProperty.call(options, 'target')
    ? (options.target ?? null)
    : makeUser();
  const existingAssignment = Object.prototype.hasOwnProperty.call(options, 'existingAssignment')
    ? (options.existingAssignment ?? null)
    : null;

  const userRepository = {
    findOne: jest.fn(
      async (query: {
        where: { id: string; tenantId?: string; isActive?: boolean };
      }): Promise<User | null> => {
        const candidate =
          query.where.id === ADMIN_ID || query.where.id === SUPER_ADMIN_ID
            ? actor
            : query.where.id === TARGET_USER_ID
              ? target
              : null;
        if (!candidate) {
          return null;
        }
        if (query.where.tenantId !== undefined && candidate.tenantId !== query.where.tenantId) {
          return null;
        }
        if (query.where.isActive !== undefined && candidate.isActive !== query.where.isActive) {
          return null;
        }
        return candidate;
      },
    ),
  };

  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(options.assignmentCandidates ?? []),
  };
  const savedAssignments: UserSiteAssignment[] = [];
  const assignmentRepository = {
    findOne: jest.fn().mockResolvedValue(existingAssignment),
    create: jest.fn(
      (input: Partial<UserSiteAssignment>): UserSiteAssignment =>
        Object.assign(new UserSiteAssignment(), input),
    ),
    save: jest.fn(async (assignment: UserSiteAssignment): Promise<UserSiteAssignment> => {
      if (!assignment.id) {
        assignment.id = ASSIGNMENT_ID;
      }
      savedAssignments.push(assignment);
      return assignment;
    }),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };

  const manager = {
    withRepository: jest.fn((repository: object): object => repository),
  };
  const dataSource = {
    transaction: jest.fn(
      async (work: (transactionManager: EntityManager) => Promise<object>): Promise<object> =>
        work(manager as never),
    ),
  };
  const auditLogService = {
    log: jest.fn().mockResolvedValue(undefined),
  };
  const farmSiteAssignmentValidator = {
    assertAssignable: jest.fn().mockResolvedValue(undefined),
  };
  const durableUserTokenInvalidation = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    applyImmediately: jest.fn().mockResolvedValue(undefined),
  };

  const service = new TenantAdminService(
    {} as never,
    {} as never,
    userRepository as never,
    {} as never,
    assignmentRepository as never,
    {} as never,
    {} as never,
    dataSource as never,
    auditLogService as never,
    farmSiteAssignmentValidator as never,
    durableUserTokenInvalidation as never,
  );

  return {
    service,
    manager,
    dataSource,
    userRepository,
    assignmentRepository,
    queryBuilder,
    savedAssignments,
    auditLogService,
    farmSiteAssignmentValidator,
    durableUserTokenInvalidation,
  };
}

describe('TenantAdminService site-assignment authority boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('creates a tenant-scoped assignment with atomic audit and durable invalidation', async () => {
    const fixture = makeFixture();

    const result = await fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
    });

    expect(result).toEqual({
      success: true,
      message: 'User assigned to site',
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
    });
    expect(fixture.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.userRepository.findOne).toHaveBeenNthCalledWith(1, {
      where: { id: ADMIN_ID, isActive: true },
      lock: { mode: 'pessimistic_read' },
    });
    expect(fixture.userRepository.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        id: TARGET_USER_ID,
        tenantId: TENANT_ID,
        isActive: true,
      },
      lock: { mode: 'pessimistic_write' },
    });
    expect(fixture.assignmentRepository.findOne).toHaveBeenCalledWith({
      where: {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
        tenantId: TENANT_ID,
      },
      lock: { mode: 'pessimistic_write' },
    });
    expect(fixture.farmSiteAssignmentValidator.assertAssignable).toHaveBeenCalledWith(
      TENANT_ID,
      SITE_ID,
    );
    expect(fixture.savedAssignments).toHaveLength(1);
    expect(fixture.savedAssignments[0]).toMatchObject({
      id: ASSIGNMENT_ID,
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
      tenantId: TENANT_ID,
      isActive: true,
      assignedBy: ADMIN_ID,
      expiresAt: null,
    });
    expect(fixture.auditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        performedBy: ADMIN_ID,
        performedByEmail: 'admin@example.test',
        action: 'USER_SITE_ASSIGNED',
        entityType: 'UserSiteAssignment',
        entityId: TARGET_USER_ID,
        details: expect.objectContaining({
          siteId: SITE_ID,
          outcome: 'created',
        }),
        severity: AuditLogSeverity.INFO,
      }),
      fixture.manager,
    );
    const expectedIntent = {
      userId: TARGET_USER_ID,
      tenantId: TENANT_ID,
      invalidatedAt: NOW,
      reason: 'site_assignment_changed',
      idempotencyKey: `site-assigned:${ASSIGNMENT_ID}:${NOW.getTime() / 1000}`,
    };
    expect(fixture.durableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
      fixture.manager,
      expectedIntent,
    );
    expect(fixture.durableUserTokenInvalidation.applyImmediately).toHaveBeenCalledWith(
      expectedIntent,
    );
    const validationOrder =
      fixture.farmSiteAssignmentValidator.assertAssignable.mock.invocationCallOrder[0];
    const persistenceOrder = fixture.assignmentRepository.save.mock.invocationCallOrder[0];
    expect(validationOrder).toBeDefined();
    expect(persistenceOrder).toBeDefined();
    expect(validationOrder!).toBeLessThan(persistenceOrder!);
  });

  it('returns a true no-op for an already-effective assignment', async () => {
    const fixture = makeFixture({ existingAssignment: makeAssignment() });

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).resolves.toEqual({
      success: true,
      message: 'User already assigned to site',
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
    });

    expect(fixture.farmSiteAssignmentValidator.assertAssignable).not.toHaveBeenCalled();
    expect(fixture.assignmentRepository.save).not.toHaveBeenCalled();
    expect(fixture.auditLogService.log).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.enqueue).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('reactivates an inactive row and clears its stale expiry', async () => {
    const inactive = makeAssignment({
      isActive: false,
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const fixture = makeFixture({ existingAssignment: inactive });

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).resolves.toMatchObject({ message: 'Site assignment reactivated' });

    expect(fixture.farmSiteAssignmentValidator.assertAssignable).toHaveBeenCalledTimes(1);
    expect(fixture.assignmentRepository.create).not.toHaveBeenCalled();
    expect(fixture.assignmentRepository.save).toHaveBeenCalledWith(inactive);
    expect(inactive).toMatchObject({
      isActive: true,
      assignedBy: ADMIN_ID,
      expiresAt: null,
    });
    expect(fixture.auditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_SITE_ASSIGNED',
        details: expect.objectContaining({ outcome: 'reactivated' }),
      }),
      fixture.manager,
    );
  });

  it('fails closed before persistence when farm-service rejects the site', async () => {
    const fixture = makeFixture();
    fixture.farmSiteAssignmentValidator.assertAssignable.mockRejectedValueOnce(
      new BadRequestException('not assignable'),
    );

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.assignmentRepository.save).not.toHaveBeenCalled();
    expect(fixture.auditLogService.log).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.enqueue).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('rejects a target outside the effective tenant before farm validation', async () => {
    const fixture = makeFixture({
      target: makeUser({ tenantId: OTHER_TENANT_ID }),
    });

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(fixture.farmSiteAssignmentValidator.assertAssignable).not.toHaveBeenCalled();
    expect(fixture.assignmentRepository.findOne).not.toHaveBeenCalled();
  });

  it.each([Role.MODULE_MANAGER, Role.TENANT_ADMIN, Role.SUPER_ADMIN])(
    'rejects explicit site assignments for the tenant-wide %s role',
    async (role) => {
      const fixture = makeFixture({ target: makeUser({ role }) });

      await expect(
        fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
          userId: TARGET_USER_ID,
          siteId: SITE_ID,
        }),
      ).rejects.toThrow('Explicit site assignments are only supported for module users');

      expect(fixture.assignmentRepository.findOne).not.toHaveBeenCalled();
      expect(fixture.farmSiteAssignmentValidator.assertAssignable).not.toHaveBeenCalled();
    },
  );

  it('enforces the module-user target boundary on read and revoke paths', async () => {
    const fixture = makeFixture({ target: makeUser({ role: Role.MODULE_MANAGER }) });

    await expect(
      fixture.service.getUserAssignedSiteIds(ADMIN_ID, TENANT_ID, TARGET_USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      fixture.service.unassignUserFromSite(ADMIN_ID, TENANT_ID, TARGET_USER_ID, SITE_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.assignmentRepository.findOne).not.toHaveBeenCalled();
    expect(fixture.assignmentRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects tenant-admin calls when trusted tenant context differs from the actor tenant', async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, OTHER_TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(fixture.userRepository.findOne).toHaveBeenCalledTimes(1);
    expect(fixture.farmSiteAssignmentValidator.assertAssignable).not.toHaveBeenCalled();
  });

  it('rejects a non-admin actor even when the resolver is bypassed', async () => {
    const fixture = makeFixture({
      actor: makeUser({ id: ADMIN_ID, role: Role.MODULE_MANAGER }),
    });

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(fixture.userRepository.findOne).toHaveBeenCalledTimes(1);
    expect(fixture.assignmentRepository.findOne).not.toHaveBeenCalled();
  });

  it('allows a super-admin to operate only through the explicit effective tenant', async () => {
    const fixture = makeFixture({
      actor: makeUser({
        id: SUPER_ADMIN_ID,
        tenantId: null,
        email: 'super-admin@example.test',
        role: Role.SUPER_ADMIN,
      }),
    });

    await expect(
      fixture.service.assignUserToSite(SUPER_ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(fixture.assignmentRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(fixture.savedAssignments[0]).toMatchObject({
      tenantId: TENANT_ID,
      assignedBy: SUPER_ADMIN_ID,
    });
  });

  it('aborts the mutation path when durable invalidation cannot join the transaction', async () => {
    const fixture = makeFixture();
    fixture.durableUserTokenInvalidation.enqueue.mockRejectedValueOnce(
      new Error('outbox unavailable'),
    );

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).rejects.toThrow('outbox unavailable');

    expect(fixture.auditLogService.log).toHaveBeenCalledTimes(1);
    expect(fixture.durableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('does not turn a committed assignment into an error when immediate invalidation fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fixture = makeFixture();
    fixture.durableUserTokenInvalidation.applyImmediately.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );

    await expect(
      fixture.service.assignUserToSite(ADMIN_ID, TENANT_ID, {
        userId: TARGET_USER_ID,
        siteId: SITE_ID,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(fixture.durableUserTokenInvalidation.enqueue).toHaveBeenCalledTimes(1);
    expect(fixture.durableUserTokenInvalidation.applyImmediately).toHaveBeenCalledTimes(1);
  });

  it('deactivates an effective assignment with atomic audit and invalidation', async () => {
    const assignment = makeAssignment();
    const fixture = makeFixture({ existingAssignment: assignment });

    const result = await fixture.service.unassignUserFromSite(
      ADMIN_ID,
      TENANT_ID,
      TARGET_USER_ID,
      SITE_ID,
    );

    expect(result).toEqual({
      success: true,
      message: 'User unassigned from site',
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
    });
    expect(assignment.isActive).toBe(false);
    expect(fixture.assignmentRepository.save).toHaveBeenCalledWith(assignment);
    expect(fixture.auditLogService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_SITE_UNASSIGNED',
        details: expect.objectContaining({
          siteId: SITE_ID,
          outcome: 'deactivated',
        }),
      }),
      fixture.manager,
    );
    const expectedIntent = {
      userId: TARGET_USER_ID,
      tenantId: TENANT_ID,
      invalidatedAt: NOW,
      reason: 'site_assignment_changed',
      idempotencyKey: `site-unassigned:${ASSIGNMENT_ID}:${NOW.getTime() / 1000}`,
    };
    expect(fixture.durableUserTokenInvalidation.enqueue).toHaveBeenCalledWith(
      fixture.manager,
      expectedIntent,
    );
    expect(fixture.durableUserTokenInvalidation.applyImmediately).toHaveBeenCalledWith(
      expectedIntent,
    );
    expect(fixture.farmSiteAssignmentValidator.assertAssignable).not.toHaveBeenCalled();
  });

  it('returns an idempotent no-op when the assignment is already ineffective', async () => {
    const fixture = makeFixture({
      existingAssignment: makeAssignment({
        expiresAt: new Date('2026-08-01T11:59:59.000Z'),
      }),
    });

    await expect(
      fixture.service.unassignUserFromSite(ADMIN_ID, TENANT_ID, TARGET_USER_ID, SITE_ID),
    ).resolves.toEqual({
      success: true,
      message: 'User already unassigned from site',
      userId: TARGET_USER_ID,
      siteId: SITE_ID,
    });

    expect(fixture.assignmentRepository.save).not.toHaveBeenCalled();
    expect(fixture.auditLogService.log).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.enqueue).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.applyImmediately).not.toHaveBeenCalled();
  });

  it('rejects unassignment when no tenant-scoped row exists', async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.unassignUserFromSite(ADMIN_ID, TENANT_ID, TARGET_USER_ID, SITE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(fixture.assignmentRepository.save).not.toHaveBeenCalled();
    expect(fixture.durableUserTokenInvalidation.enqueue).not.toHaveBeenCalled();
  });

  it('reads only canonical effective site ids under tenant-scoped read locks', async () => {
    const fixture = makeFixture({
      assignmentCandidates: [
        makeAssignment({ siteId: SITE_ID, expiresAt: null }),
        makeAssignment({
          id: '44444444-4444-4444-8444-444444444445',
          siteId: SECOND_SITE_ID,
          expiresAt: new Date('2026-08-02T12:00:00.000Z'),
        }),
        makeAssignment({
          id: '44444444-4444-4444-8444-444444444446',
          siteId: '33333333-3333-4333-8333-333333333335',
          expiresAt: NOW,
        }),
        makeAssignment({
          id: '44444444-4444-4444-8444-444444444447',
          siteId: '33333333-3333-4333-8333-333333333336',
          isActive: false,
        }),
      ],
    });

    await expect(
      fixture.service.getUserAssignedSiteIds(ADMIN_ID, TENANT_ID, TARGET_USER_ID),
    ).resolves.toEqual([SITE_ID, SECOND_SITE_ID]);

    expect(fixture.userRepository.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        id: TARGET_USER_ID,
        tenantId: TENANT_ID,
        isActive: true,
      },
      lock: { mode: 'pessimistic_read' },
    });
    expect(fixture.assignmentRepository.createQueryBuilder).toHaveBeenCalledWith('assignment');
    expect(fixture.queryBuilder.where).toHaveBeenCalledWith('assignment.userId = :userId', {
      userId: TARGET_USER_ID,
    });
    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith('assignment.tenantId = :tenantId', {
      tenantId: TENANT_ID,
    });
    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith('assignment.isActive = true');
    expect(fixture.queryBuilder.orderBy).toHaveBeenCalledWith('assignment.siteId', 'ASC');
    expect(fixture.queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
  });
});
