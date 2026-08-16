import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationPermission,
  ImpersonationSession,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

const DATABASE_NOW = new Date('2026-08-09T08:00:00.000Z');

function activeSession(id: string): ImpersonationSession {
  return Object.assign(new ImpersonationSession(), {
    id,
    status: ImpersonationStatus.ACTIVE,
    expiresAt: new Date(DATABASE_NOW.getTime() + 60 * 60 * 1000),
  });
}

describe('ImpersonationService DB-backed active-session lifecycle', () => {
  let module: TestingModule;
  let service: ImpersonationService;
  let sessionFind: jest.Mock;
  let databaseClockQuery: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    sessionFind = jest.fn().mockResolvedValue([]);
    databaseClockQuery = jest.fn().mockResolvedValue([{ databaseNow: DATABASE_NOW }]);
    module = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        {
          provide: getRepositoryToken(ImpersonationSession),
          useValue: { find: sessionFind },
        },
        {
          provide: getRepositoryToken(ImpersonationPermission),
          useValue: {},
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            manager: { query: databaseClockQuery },
          },
        },
        {
          provide: AuditLogService,
          useValue: { appendInTransaction: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(ImpersonationService);
  });

  afterEach(async () => {
    await module.close();
    jest.useRealTimers();
  });

  it('performs no eager cache warm-up and reads active sessions from PostgreSQL', async () => {
    expect(sessionFind).not.toHaveBeenCalled();
    sessionFind.mockResolvedValueOnce([activeSession('11111111-1111-4111-8111-111111111111')]);

    const active = await service.getActiveSessions();

    expect(databaseClockQuery).toHaveBeenCalledWith('SELECT clock_timestamp() AS "databaseNow"');
    expect(sessionFind).toHaveBeenCalledTimes(1);
    expect(active.map((session) => session.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('does not reuse stale process-local truth across reads', async () => {
    sessionFind
      .mockResolvedValueOnce([activeSession('11111111-1111-4111-8111-111111111111')])
      .mockResolvedValueOnce([]);

    await expect(service.getActiveSessions()).resolves.toHaveLength(1);
    await expect(service.getActiveSessions()).resolves.toEqual([]);
    expect(sessionFind).toHaveBeenCalledTimes(2);
  });

  it('cleans the non-production limiter timer during module destruction', () => {
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    service.onModuleDestroy();

    expect(jest.getTimerCount()).toBe(0);
  });
});
