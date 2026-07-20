import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

/**
 * ADMIN-CRITICAL-013 / APA-288 — intent pin: admin.impersonation_sessions is an
 * OPERATIONAL table whose every lifecycle transition is a repo.save() UPDATE on
 * an EXISTING row. The Baseline's BEFORE UPDATE write-guard trigger made all of
 * these RAISE (500); migration 1801600000000 drops it. A mocked repo cannot
 * observe the Postgres trigger — the real end-to-end proof runs in the CI
 * integration lane — so this spec documents the CODE's dependency on the row
 * being mutable: each path loads the row and persists a MUTATED copy (status
 * transitioned, timestamps/reason set), never an INSERT. If any of these paths
 * were ever refactored to stop UPDATEing, or the table were re-frozen, the
 * feature would silently break again — this locks the write-shape in.
 */
describe('ImpersonationService — lifecycle mutations UPDATE an existing row (APA-288)', () => {
  const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
  const TENANT_ID = '22222222-2222-4222-8222-222222222222';

  let service: ImpersonationService;
  let sessionRepo: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock; count: jest.Mock };
  let permissionRepo: { findOne: jest.Mock };

  const activeSession = (
    overrides: Partial<ImpersonationSession> = {},
  ): ImpersonationSession =>
    ({
      id: 'sess-1',
      superAdminId: ADMIN_ID,
      targetTenantId: TENANT_ID,
      status: ImpersonationStatus.ACTIVE,
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      endedAt: undefined,
      endReason: undefined,
      actionsPerformed: [],
      actionCount: 0,
      ...overrides,
    }) as ImpersonationSession;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    sessionRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((row: unknown) => Promise.resolve(row)),
      count: jest.fn().mockResolvedValue(0),
    };
    permissionRepo = { findOne: jest.fn().mockResolvedValue(null) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        // RedisService is @Optional() — omitted to exercise the in-memory path.
      ],
    }).compile();

    service = moduleRef.get(ImpersonationService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('endImpersonation UPDATEs the existing row to ENDED (not an insert)', async () => {
    const row = activeSession();
    sessionRepo.findOne.mockResolvedValue(row);

    await service.endImpersonation('sess-1', 'done', ADMIN_ID);

    expect(sessionRepo.save).toHaveBeenCalledTimes(1);
    const saved = sessionRepo.save.mock.calls[0][0] as ImpersonationSession;
    expect(saved.id).toBe('sess-1'); // same row → UPDATE, not INSERT
    expect(saved.status).toBe(ImpersonationStatus.ENDED);
    expect(saved.endedAt).toBeInstanceOf(Date);
  });

  it('terminateSession UPDATEs the existing row to TERMINATED', async () => {
    const row = activeSession();
    sessionRepo.findOne.mockResolvedValue(row);

    await service.terminateSession('sess-1', ADMIN_ID, 'policy');

    const saved = sessionRepo.save.mock.calls[0][0] as ImpersonationSession;
    expect(saved.id).toBe('sess-1');
    expect(saved.status).toBe(ImpersonationStatus.TERMINATED);
    expect(saved.endReason).toContain('policy');
  });

  it('extendSession UPDATEs expiresAt on the existing row', async () => {
    const row = activeSession();
    sessionRepo.findOne.mockResolvedValue(row);
    permissionRepo.findOne.mockResolvedValue({ maxSessionDurationMinutes: 60 });
    const before = row.expiresAt.getTime();

    await service.extendSession('sess-1', 5, ADMIN_ID);

    const saved = sessionRepo.save.mock.calls[0][0] as ImpersonationSession;
    expect(saved.id).toBe('sess-1');
    expect(saved.expiresAt.getTime()).toBe(before + 5 * 60_000);
    expect(saved.actionCount).toBe(1);
  });

  it('expireOldSessions UPDATEs expired ACTIVE rows to EXPIRED', async () => {
    const expired = activeSession({ id: 'sess-2', expiresAt: new Date(Date.now() - 60_000) });
    sessionRepo.find.mockResolvedValue([expired]);

    await service.expireOldSessions();

    expect(sessionRepo.save).toHaveBeenCalledTimes(1);
    const saved = sessionRepo.save.mock.calls[0][0] as ImpersonationSession;
    expect(saved.id).toBe('sess-2');
    expect(saved.status).toBe(ImpersonationStatus.EXPIRED);
  });
});
