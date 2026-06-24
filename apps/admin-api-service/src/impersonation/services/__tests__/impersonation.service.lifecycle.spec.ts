/**
 * ImpersonationService - lifecycle (onModuleInit) tests
 *
 * Proves the active-session cache warm-up contract after it moved out of the
 * constructor and into the OnModuleInit hook:
 *
 *   - The constructor performs NO async session load (it previously floated an
 *     unawaited loadActiveSessions() promise — a no-floating-promises defect).
 *   - onModuleInit() awaits the persistence read for ACTIVE sessions and
 *     populates the in-memory cache so getActiveSessions() returns them.
 *
 * This is the test mandated by the constructor → onModuleInit refactor: the
 * ordering changed (load is now awaited at module init rather than fired from
 * the constructor), so the new behavior is pinned here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const buildActiveSession = (
  overrides: Partial<ImpersonationSession> = {},
): ImpersonationSession =>
  ({
    id: 'session-active-1',
    status: ImpersonationStatus.ACTIVE,
    // Far-future expiry so getActiveSessions() does not evict it as stale.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  }) as ImpersonationSession;

const createSessionRepoMock = (): { find: jest.Mock } => ({
  find: jest.fn().mockResolvedValue([]),
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
  let sessionRepo: { find: jest.Mock };

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

  it('does not load sessions from the constructor (no eager async work)', () => {
    // TestingModule construction instantiates the provider but does NOT run
    // lifecycle hooks (compile() does not call onModuleInit). The cache must be
    // empty and the repository untouched at this point.
    expect(sessionRepo.find).not.toHaveBeenCalled();
    expect(service.getActiveSessions()).toEqual([]);
  });

  it('warms the active-session cache from persistence on onModuleInit', async () => {
    const active = buildActiveSession();
    sessionRepo.find.mockResolvedValueOnce([active]);

    await service.onModuleInit();

    expect(sessionRepo.find).toHaveBeenCalledWith({
      where: { status: ImpersonationStatus.ACTIVE },
    });
    const cached = service.getActiveSessions();
    expect(cached).toHaveLength(1);
    expect(cached.map((s) => s.id)).toEqual(['session-active-1']);
  });

  it('completes onModuleInit with an empty cache when no active sessions exist', async () => {
    sessionRepo.find.mockResolvedValueOnce([]);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(sessionRepo.find).toHaveBeenCalledTimes(1);
    expect(service.getActiveSessions()).toEqual([]);
  });
});
