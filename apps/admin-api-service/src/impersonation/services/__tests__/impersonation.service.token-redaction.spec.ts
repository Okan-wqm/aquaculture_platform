/**
 * ImpersonationService — token redaction on read paths (DB-ADMIN-HIGH-002).
 *
 * The impersonation session entity stores only the SHA-256
 * `impersonationToken` credential hash. These tests pin that every read path
 * returns the safe view without that hash; only the start response may reveal
 * the newly generated raw credential once.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
  toSafeImpersonationSession,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

const withSecrets = (overrides: Partial<ImpersonationSession> = {}): ImpersonationSession =>
  Object.assign(new ImpersonationSession(), {
    id: SESSION_ID,
    superAdminId: ADMIN_ID,
    targetTenantId: TENANT_ID,
    status: ImpersonationStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    impersonationToken: 'HASHED-IMPERSONATION-TOKEN',
    ...overrides,
  });

const expectNoSecrets = (obj: unknown): void => {
  expect(obj).toBeDefined();
  expect(obj).not.toHaveProperty('impersonationToken');
};

describe('toSafeImpersonationSession (SSoT mapper)', () => {
  it('strips the credential hash and preserves the rest', () => {
    const safe = toSafeImpersonationSession(withSecrets());
    expectNoSecrets(safe);
    expect(safe.id).toBe(SESSION_ID);
    expect(safe.superAdminId).toBe(ADMIN_ID);
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
  };
  let permissionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
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
    };
    permissionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(
        Object.assign(new ImpersonationPermission(), {
          superAdminId: ADMIN_ID,
          canImpersonate: true,
          isActive: true,
          allowedTenants: [TENANT_ID],
          restrictedTenants: [],
          maxSessionDurationMinutes: 60,
        }),
      ),
      save: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((work: (manager: unknown) => unknown) =>
              work({
                withRepository: (repository: object) =>
                  repository === permissionRepo ? permissionRepo : sessionRepo,
                query: jest
                  .fn()
                  .mockResolvedValue([{ databaseNow: new Date('2026-08-09T08:00:00.000Z') }]),
              }),
            ),
            manager: {
              query: jest
                .fn()
                .mockResolvedValue([{ databaseNow: new Date('2026-08-09T08:00:00.000Z') }]),
            },
          },
        },
        {
          provide: AuditLogService,
          useValue: { appendInTransaction: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(ImpersonationService);
  });

  it('getSession returns the safe view without token columns', async () => {
    const result = await service.getSession(SESSION_ID);
    expectNoSecrets(result);
    expect(result.id).toBe(SESSION_ID);
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
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest
        .fn()
        .mockResolvedValue([
          [withSecrets(), withSecrets({ id: '44444444-4444-4444-8444-444444444444' })],
          2,
        ]),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.querySessions({});
    const { items, total } = result;
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    expect(result).toEqual(
      expect.objectContaining({
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      }),
    );
    expect(qb.orderBy).toHaveBeenCalledWith('s.createdAt', 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('s.id', 'DESC');
    for (const s of items) expectNoSecrets(s);
  });

  it('applies server-owned search and stable pagination coordinates', async () => {
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[withSecrets()], 21]),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await service.querySessions({ search: ' Ocean ', page: 2, limit: 20 });

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(s.targetTenantName ILIKE :search OR s.superAdminEmail ILIKE :search)',
      { search: '%Ocean%' },
    );
    expect(qb.orderBy).toHaveBeenCalledWith('s.createdAt', 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('s.id', 'DESC');
    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(result).toEqual(
      expect.objectContaining({
        total: 21,
        page: 2,
        limit: 20,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      }),
    );
    expectNoSecrets(result.items[0]);
  });

  // State-transition responses are session state, not credential channels;
  // they must not echo the persisted impersonationToken hash.

  it('endImpersonation returns the safe view without token columns', async () => {
    const result = await service.endImpersonation(SESSION_ID, 'done', ADMIN_ID);
    expectNoSecrets(result);
    expect(result.status).toBe(ImpersonationStatus.ENDED);
  });

  it('terminateSession returns the safe view without token columns', async () => {
    const result = await service.terminateSession(
      SESSION_ID,
      '55555555-5555-4555-8555-555555555555',
      'operator override',
    );
    expectNoSecrets(result);
    expect(result.status).toBe(ImpersonationStatus.TERMINATED);
  });

  it('extendSession returns the safe view without token columns', async () => {
    // Recent createdAt + short extension stays inside the 60-minute default
    // cap (no active ImpersonationPermission is mocked).
    sessionRepo.findOne.mockResolvedValue(
      withSecrets({
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    const result = await service.extendSession(SESSION_ID, 5, ADMIN_ID);
    expectNoSecrets(result);
    expect(result.id).toBe(SESSION_ID);
  });

  it('getImpersonationStats strips token columns from recentSessions', async () => {
    const statsQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(statsQb);
    sessionRepo.find.mockResolvedValueOnce([
      withSecrets(),
      withSecrets({ id: '44444444-4444-4444-8444-444444444444' }),
    ]);

    const stats = await service.getImpersonationStats();
    expect(stats.recentSessions).toHaveLength(2);
    for (const s of stats.recentSessions) expectNoSecrets(s);
  });
});
