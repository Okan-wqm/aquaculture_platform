import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationPermission,
  ImpersonationReason,
  ImpersonationSession,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';

function permission(): ImpersonationPermission {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    superAdminId: OWNER_ID,
    canImpersonate: true,
    isActive: true,
    allowedTenants: [TENANT_ID],
    maxSessionDurationMinutes: 60,
    maxConcurrentSessions: 3,
    requireReason: true,
    requireTicketReference: false,
    notifyTenantAdmin: false,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    updatedAt: new Date('2026-08-15T00:00:00.000Z'),
  };
}

function session(id: string): ImpersonationSession {
  return {
    id,
    superAdminId: OWNER_ID,
    targetTenantId: TENANT_ID,
    status: ImpersonationStatus.ACTIVE,
    reason: ImpersonationReason.SECURITY_INVESTIGATION,
    mfaCompleted: true,
    expiresAt: new Date('2026-08-15T02:00:00.000Z'),
    actionCount: 0,
    createdAt: new Date('2026-08-15T01:00:00.000Z'),
    updatedAt: new Date('2026-08-15T01:00:00.000Z'),
  };
}

describe('ImpersonationService permission/session transaction authority', () => {
  it('persists a single fail-closed grant projection and its audit fact in one transaction', async () => {
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<ImpersonationPermission>) => ({
        id: '44444444-4444-4444-8444-444444444444',
        createdAt: new Date('2026-08-15T00:00:00.000Z'),
        updatedAt: new Date('2026-08-15T00:00:00.000Z'),
        ...value,
      })),
      save: jest.fn().mockImplementation((value: ImpersonationPermission) => value),
    };
    const injectedSessionRepository = {};
    const injectedPermissionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedPermissionRepository) return permissionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedPermissionRepository.manager.transaction.mockImplementation(transaction);
    const auditLogService = {
      log: jest.fn(),
      logRequired: jest.fn().mockResolvedValue({ id: 'audit-entry' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: injectedSessionRepository },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: injectedPermissionRepository,
        },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    const result = await moduleRef.get(ImpersonationService).grantImpersonationPermission({
      superAdminId: OWNER_ID,
      allowedTenants: [TENANT_ID],
      grantedBy: OPERATOR_ID,
    });

    expect(committed).toBe(true);
    expect(manager.withRepository).toHaveBeenCalledTimes(1);
    expect(manager.withRepository).toHaveBeenCalledWith(injectedPermissionRepository);
    expect(permissionRepository.findOne).toHaveBeenCalledWith({
      where: { superAdminId: OWNER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(permissionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTenants: [TENANT_ID],
        canImpersonate: true,
        isActive: true,
        notifyTenantAdmin: false,
      }),
    );
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IMPERSONATION_PERMISSION_GRANTED' }),
      manager,
    );
    expect(result).toMatchObject({ superAdminId: OWNER_ID, notifyTenantAdmin: false });
  });

  it('revokes permission, fences every active session, and appends audit facts in one transaction', async () => {
    const storedPermission = permission();
    const activeSessions = [session('session-1'), session('session-2')];
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(storedPermission),
      save: jest.fn().mockImplementation((value: ImpersonationPermission) => value),
    };
    const sessionQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(activeSessions),
    };
    const sessionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(sessionQuery),
      save: jest.fn().mockImplementation((value: ImpersonationSession[]) => value),
    };
    const injectedSessionRepository = {};
    const injectedPermissionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedPermissionRepository) return permissionRepository;
        if (repository === injectedSessionRepository) return sessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedPermissionRepository.manager.transaction.mockImplementation(transaction);
    const auditLogService = {
      log: jest.fn(),
      logRequired: jest.fn().mockResolvedValue({ id: 'audit-entry' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: injectedSessionRepository,
        },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: injectedPermissionRepository,
        },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    const service = moduleRef.get(ImpersonationService);
    await expect(
      service.revokeImpersonationPermission(OWNER_ID, OPERATOR_ID, 'Access review'),
    ).resolves.toEqual({ terminatedSessionCount: 2 });

    expect(committed).toBe(true);
    expect(manager.withRepository.mock.calls).toEqual([
      [injectedPermissionRepository],
      [injectedSessionRepository],
    ]);
    expect(permissionRepository.findOne).toHaveBeenCalledWith({
      where: { superAdminId: OWNER_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(storedPermission).toMatchObject({
      isActive: false,
      canImpersonate: false,
      revokedBy: OPERATOR_ID,
      revocationReason: 'Access review',
    });
    expect(storedPermission.revokedAt).toBeInstanceOf(Date);
    expect(activeSessions.every((value) => value.status === ImpersonationStatus.TERMINATED)).toBe(
      true,
    );
    expect(auditLogService.logRequired).toHaveBeenCalledTimes(3);
    for (const call of auditLogService.logRequired.mock.calls) {
      expect(call[1]).toBe(manager);
    }
  });

  it('does not commit a revocation when its required audit fact cannot persist', async () => {
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(permission()),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const sessionQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const transactionalSessionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(sessionQuery),
    };
    const injectedSessionRepository = {};
    const injectedPermissionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedPermissionRepository) return permissionRepository;
        if (repository === injectedSessionRepository) return transactionalSessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedPermissionRepository.manager.transaction.mockImplementation(transaction);
    const auditFailure = new Error('audit unavailable');
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: injectedSessionRepository },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: injectedPermissionRepository,
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn(),
            logRequired: jest.fn().mockRejectedValue(auditFailure),
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(ImpersonationService);
    await expect(
      service.revokeImpersonationPermission(OWNER_ID, OPERATOR_ID, 'Access review'),
    ).rejects.toBe(auditFailure);
    expect(committed).toBe(false);
    expect(manager.withRepository.mock.calls).toEqual([
      [injectedPermissionRepository],
      [injectedSessionRepository],
    ]);
  });

  it('serializes session start on the permission row and commits its audit fact atomically', async () => {
    const storedPermission = permission();
    const permissionRepository = {
      findOne: jest.fn().mockResolvedValue(storedPermission),
    };
    const sessionRepository = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<ImpersonationSession>) => ({
        id: 'session-created',
        mfaCompleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...value,
      })),
      save: jest.fn().mockImplementation((value: ImpersonationSession) => value),
    };
    const injectedSessionRepository = {};
    const injectedPermissionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedPermissionRepository) return permissionRepository;
        if (repository === injectedSessionRepository) return sessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedPermissionRepository.manager.transaction.mockImplementation(transaction);
    const auditLogService = {
      log: jest.fn(),
      logRequired: jest.fn().mockResolvedValue({ id: 'audit-entry' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: injectedSessionRepository },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: injectedPermissionRepository,
        },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    const service = moduleRef.get(ImpersonationService);
    const result = await service.startImpersonation({
      superAdminId: OWNER_ID,
      targetTenantId: TENANT_ID,
      reason: ImpersonationReason.SECURITY_INVESTIGATION,
    });

    expect(committed).toBe(true);
    expect(manager.withRepository.mock.calls).toEqual([
      [injectedPermissionRepository],
      [injectedSessionRepository],
    ]);
    expect(permissionRepository.findOne).toHaveBeenCalledWith({
      where: { superAdminId: OWNER_ID, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
    expect(sessionRepository.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ originalSessionToken: expect.anything() }),
    );
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IMPERSONATION_STARTED' }),
      manager,
    );
    expect(result.impersonationToken).toEqual(expect.any(String));
  });

  it('rolls back a lifecycle transition when its audit fact fails', async () => {
    const storedSession = session('session-end');
    const sessionRepository = {
      findOne: jest.fn().mockResolvedValue(storedSession),
      save: jest.fn().mockImplementation((value: ImpersonationSession) => value),
    };
    const injectedSessionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedSessionRepository) return sessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedSessionRepository.manager.transaction.mockImplementation(transaction);
    const auditFailure = new Error('audit unavailable');
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: injectedSessionRepository,
        },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: {} },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn(),
            logRequired: jest.fn().mockRejectedValue(auditFailure),
          },
        },
      ],
    }).compile();

    await expect(
      moduleRef.get(ImpersonationService).endImpersonation('session-end', 'Complete', OWNER_ID),
    ).rejects.toBe(auditFailure);
    expect(committed).toBe(false);
    expect(manager.withRepository).toHaveBeenCalledWith(injectedSessionRepository);
  });

  it('serializes action projection updates and immutable audit facts in one transaction', async () => {
    const storedSession = session('session-action');
    storedSession.expiresAt = new Date(Date.now() + 60_000);
    const sessionRepository = {
      findOne: jest.fn().mockResolvedValue(storedSession),
      save: jest.fn().mockImplementation((value: ImpersonationSession) => value),
    };
    const injectedSessionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedSessionRepository) return sessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    let committed = false;
    const transaction = jest.fn(
      async (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => {
        const result = await work(manager);
        committed = true;
        return result;
      },
    );
    injectedSessionRepository.manager.transaction.mockImplementation(transaction);
    const auditLogService = {
      log: jest.fn(),
      logRequired: jest.fn().mockResolvedValue({ id: 'audit-action' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: injectedSessionRepository,
        },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: {} },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    await moduleRef
      .get(ImpersonationService)
      .logAction('session-action', 'VIEW', 'tenant', TENANT_ID, undefined, OWNER_ID);

    expect(committed).toBe(true);
    expect(manager.withRepository).toHaveBeenCalledWith(injectedSessionRepository);
    expect(sessionRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'session-action' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(storedSession.actionCount).toBe(1);
    expect(storedSession.actionsPerformed).toEqual([
      expect.objectContaining({ action: 'VIEW', resource: 'tenant', resourceId: TENANT_ID }),
    ]);
    expect(auditLogService.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'IMPERSONATION_ACTION_LOGGED' }),
      manager,
    );
  });

  it('refuses extension after permission revocation instead of using a default authority', async () => {
    const storedSession = session('session-extend');
    const permissionRepository = { findOne: jest.fn().mockResolvedValue(null) };
    const sessionRepository = {
      findOne: jest.fn().mockResolvedValue(storedSession),
      save: jest.fn(),
    };
    const injectedSessionRepository = {
      findOne: jest.fn().mockResolvedValue(storedSession),
    };
    const injectedPermissionRepository = { manager: { transaction: jest.fn() } };
    const manager = {
      withRepository: jest.fn((repository: unknown) => {
        if (repository === injectedPermissionRepository) return permissionRepository;
        if (repository === injectedSessionRepository) return sessionRepository;
        throw new Error('Unexpected repository outside the injected transaction authority');
      }),
    };
    const transaction = jest.fn(
      (work: (value: typeof manager) => Promise<unknown>): Promise<unknown> => work(manager),
    );
    injectedPermissionRepository.manager.transaction.mockImplementation(transaction);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: injectedSessionRepository,
        },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: injectedPermissionRepository,
        },
        { provide: AuditLogService, useValue: {} },
      ],
    }).compile();

    await expect(
      moduleRef.get(ImpersonationService).extendSession('session-extend', 5, OWNER_ID),
    ).rejects.toThrow('No impersonation permission granted');
    expect(sessionRepository.save).not.toHaveBeenCalled();
    expect(manager.withRepository.mock.calls).toEqual([
      [injectedPermissionRepository],
      [injectedSessionRepository],
    ]);
  });
});
