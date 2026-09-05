/**
 * The impersonation audit summary must cover the window it claims.
 *
 * `totalSessions` counted `createdAt < end` and ignored `start`, so it reported
 * every session ever created while every sibling aggregate in the same response
 * honoured both bounds. The admin panel rendered exactly that field under a
 * "Total Sessions (30d)" heading, which made the most prominent number on a
 * privileged-access audit surface wrong by however long the platform had been
 * running — and wrong in the reassuring direction only until the platform aged
 * past a month.
 *
 * These tests pin the window at both ends, the derived-label bounds, and the
 * fields the deleted `/impersonation/stats` endpoint used to own.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Between, FindOperator } from 'typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationReason,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';
import { ImpersonationService } from '../impersonation.service';

describe('ImpersonationService.getAuditSummary', () => {
  let service: ImpersonationService;
  let sessionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let permissionRepo: { count: jest.Mock; findOne: jest.Mock; find: jest.Mock };

  /** A query-builder double whose terminal call is chosen per invocation. */
  const queryBuilder = (raw: { many?: unknown[]; one?: unknown }) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(raw.many ?? []),
    getRawOne: jest.fn().mockResolvedValue(raw.one ?? { actions: '0' }),
  });

  beforeEach(async () => {
    sessionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    permissionRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: getRepositoryToken(ImpersonationSession), useValue: sessionRepo },
        { provide: getRepositoryToken(ImpersonationPermission), useValue: permissionRepo },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(ImpersonationService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts only sessions created INSIDE the window', async () => {
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-07-01T00:00:00Z');
    sessionRepo.createQueryBuilder.mockImplementation(() => queryBuilder({}));

    await service.getAuditSummary(start, end);

    // The first count() is the windowed session total.
    const [firstCountArgs] = sessionRepo.count.mock.calls;
    const where = (firstCountArgs?.[0] as { where: { createdAt: unknown } }).where;

    expect(where.createdAt).toBeInstanceOf(FindOperator);
    expect(where.createdAt).toEqual(Between(start, end));
  });

  it('reports the window it used so the caller can label the numbers', async () => {
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-07-01T00:00:00Z');
    sessionRepo.createQueryBuilder.mockImplementation(() => queryBuilder({}));

    const summary = await service.getAuditSummary(start, end);

    expect(summary.windowStart).toBe(start.toISOString());
    expect(summary.windowEnd).toBe(end.toISOString());
  });

  it('defaults to a trailing 30-day window', async () => {
    sessionRepo.createQueryBuilder.mockImplementation(() => queryBuilder({}));

    const summary = await service.getAuditSummary();

    const spanDays =
      (new Date(summary.windowEnd).getTime() - new Date(summary.windowStart).getTime()) /
      (24 * 60 * 60 * 1000);
    expect(Math.round(spanDays)).toBe(30);
  });

  it('sums the action count over the window instead of leaving it to the caller', async () => {
    // The page summed `actionCount` across whatever rows the first unpaginated
    // session page happened to hold — 20 of them, on an unbounded table.
    sessionRepo.createQueryBuilder.mockImplementation(() =>
      queryBuilder({ one: { actions: '4211' } }),
    );

    const summary = await service.getAuditSummary();

    expect(summary.actionsLoggedInWindow).toBe(4211);
  });

  it('carries the point-in-time counts the deleted /stats endpoint owned', async () => {
    sessionRepo.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    permissionRepo.count.mockResolvedValueOnce(11);
    sessionRepo.createQueryBuilder.mockImplementation(() => queryBuilder({}));

    const summary = await service.getAuditSummary();

    expect(summary.totalSessionsInWindow).toBe(7);
    expect(summary.activeSessionsNow).toBe(3);
    expect(summary.activePermissionsNow).toBe(11);
    // The point-in-time active count asks for status, never a date range.
    expect(sessionRepo.count).toHaveBeenNthCalledWith(2, {
      where: { status: ImpersonationStatus.ACTIVE },
    });
  });

  it('zero-fills every reason so the breakdown has no absent keys', async () => {
    sessionRepo.createQueryBuilder.mockImplementation(() =>
      queryBuilder({ many: [{ reason: ImpersonationReason.DEBUGGING, count: '5' }] }),
    );

    const summary = await service.getAuditSummary();

    expect(summary.sessionsByReasonInWindow[ImpersonationReason.DEBUGGING]).toBe(5);
    expect(summary.sessionsByReasonInWindow[ImpersonationReason.OTHER]).toBe(0);
    expect(Object.keys(summary.sessionsByReasonInWindow).sort()).toEqual(
      Object.values(ImpersonationReason).sort(),
    );
  });

  it('windows the recent-session list too', async () => {
    const start = new Date('2026-06-01T00:00:00Z');
    const end = new Date('2026-07-01T00:00:00Z');
    sessionRepo.createQueryBuilder.mockImplementation(() => queryBuilder({}));

    await service.getAuditSummary(start, end);

    // A "recent" list that ignores the window mixes periods inside one response.
    const findArgs = sessionRepo.find.mock.calls.at(-1)?.[0] as {
      where: { createdAt: unknown };
    };
    expect(findArgs.where.createdAt).toEqual(Between(start, end));
  });
});
