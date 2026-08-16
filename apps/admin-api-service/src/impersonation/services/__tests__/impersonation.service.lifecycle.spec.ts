/**
 * ImpersonationService - active-session authority tests
 *
 * PostgreSQL is the only session-state authority. Every active-session read
 * queries persistence; there is no process-local cache to diverge across
 * replicas or survive a permission revocation as stale state.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationReason,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const buildActiveSession = (overrides: Partial<ImpersonationSession> = {}): ImpersonationSession =>
  ({
    id: 'session-active-1',
    superAdminId: '11111111-1111-4111-8111-111111111111',
    targetTenantId: '22222222-2222-4222-8222-222222222222',
    status: ImpersonationStatus.ACTIVE,
    reason: ImpersonationReason.SUPPORT_REQUEST,
    mfaCompleted: true,
    actionCount: 0,
    // Far-future expiry so getActiveSessions() does not evict it as stale.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ImpersonationSession;

const createSessionRepoMock = (): { find: jest.Mock; count: jest.Mock } => ({
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
});

const createPermissionRepoMock = (): Record<string, jest.Mock> => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn(),
});

const createAuditLogServiceMock = (): { log: jest.Mock } => ({
  log: jest.fn().mockResolvedValue(undefined),
});

describe('ImpersonationService - lifecycle', () => {
  let service: ImpersonationService;
  let sessionRepo: { find: jest.Mock; count: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionRepo = createSessionRepoMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: createPermissionRepoMock(),
        },
        { provide: AuditLogService, useValue: createAuditLogServiceMock() },
        // RedisService is @Optional() — omitting it exercises the in-memory path.
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
  });

  it('does not create a process-local session authority during construction', () => {
    expect(sessionRepo.find).not.toHaveBeenCalled();
  });

  it('reads active sessions from persistence on every request', async () => {
    const active = buildActiveSession();
    sessionRepo.find.mockResolvedValue([active]);

    const first = await service.getActiveSessions();
    const second = await service.getActiveSessions();

    expect(sessionRepo.find).toHaveBeenCalledTimes(2);
    expect(first.map((session) => session.id)).toEqual(['session-active-1']);
    expect(second.map((session) => session.id)).toEqual(['session-active-1']);
  });

  it('derives the active count from persistence', async () => {
    sessionRepo.count.mockResolvedValueOnce(4);

    await expect(service.getActiveSessionCount()).resolves.toBe(4);

    expect(sessionRepo.count).toHaveBeenCalledTimes(1);
  });
});
