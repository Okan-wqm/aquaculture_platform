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
import { isStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
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
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    originalSessionToken: 'PLAINTEXT-SESSION-TOKEN',
    impersonationToken: 'HASHED-IMPERSONATION-TOKEN',
    ...overrides,
  }) as ImpersonationSession;

const expectNoSecrets = (obj: unknown): void => {
  expect(obj).toBeDefined();
  expect(obj as Record<string, unknown>).not.toHaveProperty('originalSessionToken');
  expect(obj as Record<string, unknown>).not.toHaveProperty('impersonationToken');
};

describe('toSafeImpersonationSession (SSoT mapper)', () => {
  it('strips both secret columns and preserves the rest', () => {
    const safe = toSafeImpersonationSession(withSecrets());
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
      save: jest.fn().mockImplementation((session: ImpersonationSession) => Promise.resolve(session)),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    permissionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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
    // Warm the in-memory active cache from persistence (onModuleInit path).
    sessionRepo.find.mockResolvedValueOnce([withSecrets()]);
    await service.onModuleInit();

    const active = service.getActiveSessions();
    expect(active.length).toBeGreaterThan(0);
    for (const s of active) expectNoSecrets(s);
  });

  it('querySessions strips token columns from every item', async () => {
    const qb = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[withSecrets(), withSecrets({ id: 'session-2' })], 2]),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(qb);

    const { items, total } = await service.querySessions({});
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    for (const s of items) expectNoSecrets(s);
  });

  /**
   * APA-283. This list used to return a bare `{ items, total }` — the page
   * numerics were never computed, so `isStandardPaginatedResult` rejected it,
   * the ResponseInterceptor shipped it unlifted, and the FE had to declare a
   * bespoke `{ items, total }` type for this one endpoint. With no page/limit/
   * totalPages on the wire, the impersonation-audit surface could not paginate
   * at all: it showed the 20 most recent sessions and gave the operator no way
   * to know a 21st existed.
   */
  it('querySessions returns the canonical paginated envelope (APA-283)', async () => {
    sessionRepo.createQueryBuilder.mockReturnValue({
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[withSecrets()], 42]),
    });

    const result = await service.querySessions({ page: 2, limit: 20 });

    expect(isStandardPaginatedResult(result)).toBe(true);
    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(20);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(true);
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
    // Recent createdAt + short extension stays inside the 60-minute default
    // cap (no active ImpersonationPermission is mocked).
    sessionRepo.findOne.mockResolvedValueOnce(
      withSecrets({
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );

    const result = await service.extendSession('session-1', 5, 'admin-1');
    expectNoSecrets(result);
    expect(result.id).toBe('session-1');
  });

  // APA-297 folded the all-time `getImpersonationStats` into the windowed
  // `getAuditSummary`; the redaction guarantee it carried moves with it, since
  // the recent-session block is still the one place raw entities reach a
  // response body.
  it('getAuditSummary strips token columns from the recent-session block', async () => {
    const summaryQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn().mockResolvedValue({ actions: '0' }),
    };
    sessionRepo.createQueryBuilder.mockReturnValue(summaryQb);
    sessionRepo.find.mockResolvedValueOnce([withSecrets(), withSecrets({ id: 'session-2' })]);

    const summary = await service.getAuditSummary();
    expect(summary.recentSessionsInWindow).toHaveLength(2);
    for (const s of summary.recentSessionsInWindow) expectNoSecrets(s);
  });
});
