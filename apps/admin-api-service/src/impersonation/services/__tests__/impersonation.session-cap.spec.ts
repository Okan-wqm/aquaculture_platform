/**
 * RBAC-MEDIUM-009 — impersonation session-duration ceiling.
 *
 * The impersonation session ceiling is a single policy constant
 * (IMPERSONATION_MAX_SESSION_MINUTES = 60). Before the cure, the request DTO
 * accepted up to 480 min and grants up to 1440 min — 8-24× the policy — and
 * a historical over-cap grant row would confer an over-long session at USE
 * time regardless of the DTO. These tests pin the SERVICE-LAYER clamps that
 * make the ceiling hold even when the DTO layer is bypassed or a stale grant
 * predates the cap:
 *   - grant clamps maxSessionDurationMinutes on create AND update;
 *   - startImpersonation clamps the effective duration to the ceiling even
 *     when the stored grant says 1440;
 *   - extendSession bounds TOTAL duration by the ceiling, not the grant.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
  ImpersonationReason,
  IMPERSONATION_MAX_SESSION_MINUTES,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('ImpersonationService — session-duration cap (RBAC-MEDIUM-009)', () => {
  let service: ImpersonationService;
  let sessionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let permissionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      // create passes the entity through; save echoes it back with the values set.
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    permissionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: unknown) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<ImpersonationService>(ImpersonationService);
  });

  it('clamps a grant that requests more than the ceiling (create path)', async () => {
    permissionRepo.findOne.mockResolvedValue(null); // new grant
    const result = await service.grantImpersonationPermission({
      superAdminId: ADMIN_ID,
      allowedTenants: [TENANT_ID],
      maxSessionDurationMinutes: 1440, // 24 h — the historical max the DTO used to allow
      grantedBy: ADMIN_ID,
    });
    expect(result.maxSessionDurationMinutes).toBe(IMPERSONATION_MAX_SESSION_MINUTES);
  });

  it('clamps a grant UPDATE that raises the duration above the ceiling', async () => {
    permissionRepo.findOne.mockResolvedValue({
      id: 'perm-1',
      superAdminId: ADMIN_ID,
      maxSessionDurationMinutes: 60,
      isActive: true,
    });
    const result = await service.grantImpersonationPermission({
      superAdminId: ADMIN_ID,
      allowedTenants: [TENANT_ID],
      maxSessionDurationMinutes: 600,
      grantedBy: ADMIN_ID,
    });
    expect(result.maxSessionDurationMinutes).toBe(IMPERSONATION_MAX_SESSION_MINUTES);
  });

  it('starts a session no longer than the ceiling even when the stored grant says 1440', async () => {
    // A grant row that predates the cap (persisted 1440) must not confer a
    // 24-hour session at USE time.
    permissionRepo.findOne.mockResolvedValue({
      id: 'perm-legacy',
      superAdminId: ADMIN_ID,
      isActive: true,
      canImpersonate: true,
      allowedTenants: [TENANT_ID],
      maxSessionDurationMinutes: 1440,
      maxConcurrentSessions: 3,
      requireReason: false,
      requireTicketReference: false,
    });

    const before = Date.now();
    const session = await service.startImpersonation({
      superAdminId: ADMIN_ID,
      targetTenantId: TENANT_ID,
      reason: ImpersonationReason.SUPPORT_REQUEST,
      durationMinutes: 1440, // caller also asks for 24 h
    });

    const ttlMinutes = (new Date(session.expiresAt).getTime() - before) / 60000;
    // Ceiling holds regardless of the grant and the request.
    expect(ttlMinutes).toBeLessThanOrEqual(IMPERSONATION_MAX_SESSION_MINUTES + 0.5);
    expect(ttlMinutes).toBeGreaterThan(IMPERSONATION_MAX_SESSION_MINUTES - 1);
  });

  it('extendSession bounds TOTAL duration by the ceiling, not the stored grant', async () => {
    const createdAt = new Date(Date.now() - 50 * 60000); // started 50 min ago
    const expiresAt = new Date(Date.now() + 10 * 60000); // 10 min left (60 min total)
    sessionRepo.findOne.mockResolvedValue({
      id: 'session-1',
      superAdminId: ADMIN_ID,
      status: ImpersonationStatus.ACTIVE,
      createdAt,
      expiresAt,
      actionsPerformed: [],
    });
    permissionRepo.findOne.mockResolvedValue({
      id: 'perm-legacy',
      superAdminId: ADMIN_ID,
      isActive: true,
      maxSessionDurationMinutes: 1440, // stale over-cap grant
    });

    // Session is already at the 60-min ceiling → ANY extension must be refused.
    await expect(
      service.extendSession('session-1', 30, ADMIN_ID),
    ).rejects.toThrow(new RegExp(`${IMPERSONATION_MAX_SESSION_MINUTES}`));
  });
});
