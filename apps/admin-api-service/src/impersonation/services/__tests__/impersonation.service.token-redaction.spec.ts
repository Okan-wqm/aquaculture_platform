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
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(withSecrets()),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn(), save: jest.fn() },
        },
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
});
