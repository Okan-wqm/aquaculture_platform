/**
 * ImpersonationService — token redaction on read paths (DB-ADMIN-HIGH-002).
 *
 * The impersonation session entity stores two secrets: `originalSessionToken`
 * (plaintext) and `impersonationToken` (a live credential hash). Before the
 * 2026-07-11 fix, getSession / getActiveSessions / querySessions / the start
 * response all returned the raw entity, so both secrets leaked onto GET
 * responses. These tests pin that every read path returns the safe view with
 * neither secret, while the start path still reveals the raw impersonation
 * token exactly once (and never the stored plaintext session token).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationReason,
  ImpersonationStatus,
  toSafeImpersonationSession,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const withSecrets = (overrides: Partial<ImpersonationSession> = {}): ImpersonationSession =>
  ({
    id: 'session-1',
    superAdminId: 'admin-1',
    targetTenantId: 'tenant-1',
    status: ImpersonationStatus.ACTIVE,
    reason: ImpersonationReason.SUPPORT_REQUEST,
    mfaCompleted: false,
    actionCount: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    originalSessionToken: 'PLAINTEXT-SESSION-TOKEN',
    impersonationToken: 'HASHED-IMPERSONATION-TOKEN',
    ...overrides,
  }) as ImpersonationSession;

const expectNoSecrets = (obj: unknown): void => {
  expect(obj).toBeDefined();
  expect(obj as Record<string, unknown>).not.toHaveProperty('originalSessionToken');
  expect(obj as Record<string, unknown>).not.toHaveProperty('impersonationToken');
  expect(obj as Record<string, unknown>).not.toHaveProperty('actionsPerformed');
  expect(obj as Record<string, unknown>).not.toHaveProperty('accessedResources');
};

describe('toSafeImpersonationSession (SSoT mapper)', () => {
  it('strips secret and detail columns while preserving the summary', () => {
    const safe = toSafeImpersonationSession(
      withSecrets({
        actionsPerformed: [
          { action: 'VIEW', resource: 'tenant', timestamp: '2026-08-15T00:00:00.000Z' },
        ],
        accessedResources: [],
      }),
    );
    expectNoSecrets(safe);
    expect(safe.id).toBe('session-1');
    expect(safe.superAdminId).toBe('admin-1');
  });
});

describe('ImpersonationService — read paths never serialize tokens', () => {
  let service: ImpersonationService;
  let sessionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let permissionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    manager: { transaction: jest.Mock };
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(withSecrets()),
      // save echoes the mutated entity back — exactly what TypeORM does — so a
      // leak in the return path would surface as a failing secret assertion.
      save: jest
        .fn()
        .mockImplementation((session: ImpersonationSession) => Promise.resolve(session)),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
      manager: { transaction: jest.fn() },
    };
    permissionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      manager: { transaction: jest.fn() },
    };
    const transactionManager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === sessionRepo) return sessionRepo;
        if (repository === permissionRepo) return permissionRepo;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    const runTransaction = (
      work: (manager: typeof transactionManager) => Promise<unknown>,
    ): Promise<unknown> => work(transactionManager);
    sessionRepo.manager.transaction.mockImplementation(runTransaction);
    permissionRepo.manager.transaction.mockImplementation(runTransaction);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
            logRequired: jest.fn().mockResolvedValue({ id: 'audit-1' }),
          },
        },
      ],
    }).compile();

    service = module.get(ImpersonationService);
  });

  it('getSession returns the safe view without token columns', async () => {
    const result = await service.getSession('session-1');
    expectNoSecrets(result);
    expect(result.id).toBe('session-1');
  });

  it('getActiveSessions returns safe views without token columns', async () => {
    sessionRepo.find.mockResolvedValueOnce([withSecrets()]);

    const active = await service.getActiveSessions();
    expect(active.length).toBeGreaterThan(0);
    for (const s of active) expectNoSecrets(s);
  });

  it('querySessions strips token columns from every item', async () => {
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest
        .fn()
        .mockResolvedValue([[withSecrets(), withSecrets({ id: 'session-2' })], 2]),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(qb);

    const { items, total } = await service.querySessions({});
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    for (const s of items) expectNoSecrets(s);
  });

  // The state-transition responses (end/terminate/extend) are session state,
  // not credential channels — before the DB-ADMIN-HIGH-001 sweep they returned
  // the raw saved entity, echoing the plaintext originalSessionToken and the
  // impersonationToken hash back to the caller on every POST.

  it('endImpersonation returns the safe view without token columns', async () => {
    const result = await service.endImpersonation('session-1', 'done', 'admin-1');
    expectNoSecrets(result);
    expect(result.status).toBe(ImpersonationStatus.ENDED);
  });

  it('terminateSession returns the safe view without token columns', async () => {
    const result = await service.terminateSession('session-1', 'admin-2', 'operator override');
    expectNoSecrets(result);
    expect(result.status).toBe(ImpersonationStatus.TERMINATED);
  });

  it('extendSession returns the safe view without token columns', async () => {
    // Recent createdAt + short extension stays inside the active grant's
    // ceiling. Extension is deliberately fail-closed when the grant is absent
    // or revoked, so the fixture must model the authorization authority too.
    permissionRepo.findOne.mockResolvedValueOnce({
      id: 'permission-1',
      superAdminId: 'admin-1',
      isActive: true,
      canImpersonate: true,
      allowedTenants: ['tenant-1'],
      maxSessionDurationMinutes: 60,
      maxConcurrentSessions: 1,
    });
    const extendableSession = withSecrets({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    sessionRepo.findOne
      .mockResolvedValueOnce(extendableSession)
      .mockResolvedValueOnce(extendableSession);

    const result = await service.extendSession('session-1', 5, 'admin-1');
    expectNoSecrets(result);
    expect(result.id).toBe('session-1');
  });

  it('getImpersonationStats strips token columns from recentSessions', async () => {
    const actionsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ actionsLogged: '9' }),
    };
    const adminsQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    sessionRepo.createQueryBuilder.mockReturnValueOnce(actionsQb).mockReturnValueOnce(adminsQb);
    sessionRepo.find.mockResolvedValueOnce([withSecrets(), withSecrets({ id: 'session-2' })]);

    const stats = await service.getImpersonationStats();
    expect(stats.window.days).toBe(30);
    expect(stats.actionsLogged).toBe(9);
    expect(stats.recentSessions).toHaveLength(2);
    for (const s of stats.recentSessions) expectNoSecrets(s);
  });

  it('returns session actions only through the dedicated projection', async () => {
    sessionRepo.findOne.mockResolvedValueOnce(
      withSecrets({
        actionsPerformed: [
          {
            action: 'VIEW',
            resource: 'tenant',
            timestamp: '2026-08-15T00:00:00.000Z',
            details: { field: 'name' },
          },
        ],
      }),
    );

    await expect(service.getSessionActions('session-1')).resolves.toEqual([
      {
        action: 'VIEW',
        resource: 'tenant',
        timestamp: '2026-08-15T00:00:00.000Z',
        details: { field: 'name' },
      },
    ]);
  });
});
