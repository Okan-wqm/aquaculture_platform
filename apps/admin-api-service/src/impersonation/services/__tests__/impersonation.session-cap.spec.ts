import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { DEFAULT_IMPERSONATION_PERMISSIONS } from '@aquaculture/shared-contracts';

import { AuditLogService } from '../../../audit/audit.service';
import {
  IMPERSONATION_MAX_SESSION_MINUTES,
  ImpersonationPermission,
  ImpersonationReason,
  ImpersonationSession,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const DATABASE_NOW = new Date('2026-08-09T08:00:00.000Z');

describe('ImpersonationService strict session-duration authority', () => {
  let module: TestingModule;
  let service: ImpersonationService;
  let sessionRepo: {
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let permissionRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    sessionRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<ImpersonationSession>) =>
        Object.assign(new ImpersonationSession(), value),
      ),
      save: jest.fn((value: ImpersonationSession) => Promise.resolve(value)),
    };
    permissionRepo = {
      findOne: jest.fn(),
      create: jest.fn((value: Partial<ImpersonationPermission>) =>
        Object.assign(new ImpersonationPermission(), value),
      ),
      save: jest.fn((value: ImpersonationPermission) => Promise.resolve(value)),
    };
    const manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('clock_timestamp') ? [{ databaseNow: DATABASE_NOW }] : []),
      ),
      withRepository: jest.fn((repository: object) =>
        repository === permissionRepo ? permissionRepo : sessionRepo,
      ),
    };
    module = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((work: (value: typeof manager) => unknown) => work(manager)),
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

  afterEach(async () => {
    await module.close();
  });

  it('rejects an over-ceiling grant instead of silently clamping it', async () => {
    await expect(
      service.grantImpersonationPermission({
        superAdminId: ADMIN_ID,
        allowedTenants: [TENANT_ID],
        maxSessionDurationMinutes: 1440,
        grantedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(`between 1 and ${IMPERSONATION_MAX_SESSION_MINUTES}`);
    expect(permissionRepo.save).not.toHaveBeenCalled();
  });

  it('rejects an invalid historical stored limit at use time', async () => {
    permissionRepo.findOne.mockResolvedValue(
      Object.assign(new ImpersonationPermission(), {
        id: '33333333-3333-4333-8333-333333333333',
        superAdminId: ADMIN_ID,
        isActive: true,
        canImpersonate: true,
        allowedTenants: [TENANT_ID],
        restrictedTenants: [],
        defaultPermissions: DEFAULT_IMPERSONATION_PERMISSIONS,
        maxSessionDurationMinutes: 1440,
        maxConcurrentSessions: 3,
        requireReason: true,
        requireTicketReference: false,
        notifyTenantAdmin: false,
      }),
    );

    await expect(
      service.startImpersonation({
        superAdminId: ADMIN_ID,
        targetTenantId: TENANT_ID,
        reason: ImpersonationReason.SUPPORT_REQUEST,
        durationMinutes: 60,
        ipAddress: '198.51.100.44',
        userAgent: 'session-cap-test/1.0',
        mfaVerified: true,
      }),
    ).rejects.toThrow('Stored maxSessionDurationMinutes policy is invalid');
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('derives a valid expiry from the PostgreSQL clock authority', async () => {
    permissionRepo.findOne.mockResolvedValue(
      Object.assign(new ImpersonationPermission(), {
        id: '33333333-3333-4333-8333-333333333333',
        superAdminId: ADMIN_ID,
        isActive: true,
        canImpersonate: true,
        allowedTenants: [TENANT_ID],
        restrictedTenants: [],
        defaultPermissions: DEFAULT_IMPERSONATION_PERMISSIONS,
        maxSessionDurationMinutes: 60,
        maxConcurrentSessions: 3,
        requireReason: true,
        requireTicketReference: false,
        notifyTenantAdmin: false,
      }),
    );

    const started = await service.startImpersonation({
      superAdminId: ADMIN_ID,
      targetTenantId: TENANT_ID,
      reason: ImpersonationReason.SUPPORT_REQUEST,
      durationMinutes: 30,
      ipAddress: '198.51.100.44',
      userAgent: 'session-cap-test/1.0',
      mfaVerified: true,
    });

    expect(started.expiresAt).toEqual(new Date(DATABASE_NOW.getTime() + 30 * 60_000));
    expect(started.mfaCompleted).toBe(true);
  });

  it('bounds total extension duration by the stored strict ceiling', async () => {
    const session = Object.assign(new ImpersonationSession(), {
      id: '44444444-4444-4444-8444-444444444444',
      superAdminId: ADMIN_ID,
      targetTenantId: TENANT_ID,
      status: ImpersonationStatus.ACTIVE,
      createdAt: new Date(DATABASE_NOW.getTime() - 50 * 60_000),
      expiresAt: new Date(DATABASE_NOW.getTime() + 10 * 60_000),
      actionsPerformed: [],
      actionCount: 0,
    });
    sessionRepo.findOne.mockResolvedValue(session);
    permissionRepo.findOne.mockResolvedValue(
      Object.assign(new ImpersonationPermission(), {
        superAdminId: ADMIN_ID,
        isActive: true,
        canImpersonate: true,
        allowedTenants: [TENANT_ID],
        restrictedTenants: [],
        maxSessionDurationMinutes: 60,
      }),
    );

    await expect(service.extendSession(session.id, 5, ADMIN_ID)).rejects.toThrow('60');
  });
});
