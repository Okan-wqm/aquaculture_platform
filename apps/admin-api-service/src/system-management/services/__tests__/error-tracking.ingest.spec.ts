/**
 * The error-tracking ingest path is safe to put traffic in front of
 * (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `reportError` had zero callers, so four defects in it had never fired:
 *
 *   1. a non-atomic read-then-insert against the UNIQUE `fingerprint` index —
 *      two identical errors arriving together is the definition of an incident,
 *      and the second gets a 23505;
 *   2. `LessThan(windowStart)` on the alert window, the exact inverse of
 *      "occurrences in the last N minutes";
 *   3. a full alert-rule table scan on every single call, so error volume
 *      amplified database load and a database-caused outage fed itself;
 *   4. the raw message written unmasked and untruncated into a `varchar(500)`
 *      column, in a table the tenant-erasure registry marks `excluded`.
 *
 * Each case below fails on the pre-fix implementation.
 */
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThanOrEqual } from 'typeorm';

import {
  ErrorAlertRule,
  ErrorGroup,
  ErrorOccurrence,
  ErrorSeverity,
} from '../../entities/error-tracking.entity';
import { ErrorTrackingService } from '../error-tracking.service';

const passThroughScheduledJobs: ScheduledJobExecutor = {
  run: async (_job, body) => {
    await body();
    return 'ran';
  },
};

const GROUP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

interface Harness {
  service: ErrorTrackingService;
  groupRepo: {
    query: jest.Mock;
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  occurrenceRepo: {
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  ruleRepo: { find: jest.Mock; delete: jest.Mock };
  distinctUsers: { select: jest.Mock; getRawOne: jest.Mock };
}

async function build(options: { rules?: Partial<ErrorAlertRule>[] } = {}): Promise<Harness> {
  const distinctUsers = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
  };
  const groupRepo = {
    query: jest.fn().mockResolvedValue([{ id: GROUP_ID, inserted: true }]),
    findOne: jest.fn(),
    findOneBy: jest.fn().mockResolvedValue({
      id: GROUP_ID,
      severity: ErrorSeverity.ERROR,
      status: 'new',
      message: 'boom',
      occurrenceCount: 1,
    }),
    save: jest.fn(),
    create: jest.fn(),
  };
  const occurrenceRepo = {
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn(async (entity: unknown) => entity),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn().mockReturnValue(distinctUsers),
  };
  const ruleRepo = {
    find: jest.fn().mockResolvedValue(options.rules ?? []),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ErrorTrackingService,
      { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
      { provide: getRepositoryToken(ErrorOccurrence), useValue: occurrenceRepo },
      { provide: getRepositoryToken(ErrorGroup), useValue: groupRepo },
      { provide: getRepositoryToken(ErrorAlertRule), useValue: ruleRepo },
    ],
  }).compile();

  return {
    service: module.get(ErrorTrackingService),
    groupRepo,
    occurrenceRepo,
    ruleRepo,
    distinctUsers,
  };
}

describe('ErrorTrackingService ingest path', () => {
  it('folds the group in ONE statement — never read-then-insert against a unique index', async () => {
    const { service, groupRepo } = await build();

    await service.reportError({ message: 'boom', service: 'farm-service' });

    expect(groupRepo.findOne).not.toHaveBeenCalled();
    expect(groupRepo.save).not.toHaveBeenCalled();
    expect(groupRepo.query).toHaveBeenCalledTimes(1);
    const sql = String(groupRepo.query.mock.calls[0][0]);
    expect(sql).toMatch(/ON CONFLICT \("fingerprint"\) DO UPDATE/);
  });

  it('reads whether the group is new from the statement itself, not a second query', async () => {
    const { service, groupRepo } = await build();

    await service.reportError({ message: 'boom' });

    // xmax = 0 is true only for the row this statement inserted.
    expect(String(groupRepo.query.mock.calls[0][0])).toMatch(/\(xmax = 0\) AS inserted/);
  });

  it('raises rather than writing an occurrence pointing at a group that does not exist', async () => {
    const { service, groupRepo, occurrenceRepo } = await build();
    groupRepo.query.mockResolvedValue([]);

    await expect(service.reportError({ message: 'boom' })).rejects.toThrow('returned no row');
    expect(occurrenceRepo.save).not.toHaveBeenCalled();
  });

  it('masks PII out of both messages — error_groups is excluded from tenant erasure', async () => {
    const { service, groupRepo, occurrenceRepo } = await build();

    await service.reportError({ message: 'login failed for alice@example.com' });

    const groupMessage = String(groupRepo.query.mock.calls[0][1][3]);
    expect(groupMessage).not.toContain('alice@example.com');
    expect(groupMessage).toContain('[EMAIL-REDACTED]');
    const occurrenceMessage = String(occurrenceRepo.create.mock.calls[0][0].message);
    expect(occurrenceMessage).not.toContain('alice@example.com');
  });

  it('truncates both messages to the varchar(500) the columns actually are', async () => {
    const { service, groupRepo, occurrenceRepo } = await build();

    await service.reportError({ message: 'x'.repeat(4000) });

    expect(String(groupRepo.query.mock.calls[0][1][3]).length).toBeLessThanOrEqual(500);
    const occurrenceMessage = String(occurrenceRepo.create.mock.calls[0][0].message);
    expect(occurrenceMessage.length).toBeLessThanOrEqual(500);
    expect(occurrenceMessage).toContain('…<truncated>');
  });

  it('counts occurrences INSIDE the alert window, not the ones outside it', async () => {
    const group = {
      id: GROUP_ID,
      severity: ErrorSeverity.ERROR,
      status: 'new',
      message: 'boom',
      occurrenceCount: 9,
    };
    const { service, groupRepo, occurrenceRepo } = await build({
      rules: [
        {
          id: 'rule-1',
          name: 'burst',
          isActive: true,
          cooldownMinutes: 15,
          conditions: { occurrenceThreshold: 5, timeWindowMinutes: 10 },
          actions: [],
        } as Partial<ErrorAlertRule>,
      ],
    });
    groupRepo.findOneBy.mockResolvedValue(group);

    await service.reportError({ message: 'boom' });

    expect(occurrenceRepo.count).toHaveBeenCalledTimes(1);
    const where = occurrenceRepo.count.mock.calls[0][0].where as { timestamp: unknown };
    // The pre-fix code passed LessThan(windowStart) here, so a live burst could
    // never reach the threshold and stale history always did.
    expect(where.timestamp).toEqual(MoreThanOrEqual(expect.any(Date)));
  });

  it('derives the user threshold from distinct occurrence users, not a stored counter', async () => {
    const { service, groupRepo, occurrenceRepo, distinctUsers } = await build({
      rules: [
        {
          id: 'rule-2',
          name: 'widespread',
          isActive: true,
          cooldownMinutes: 15,
          conditions: { userCountThreshold: 3 },
          actions: [],
        } as Partial<ErrorAlertRule>,
      ],
    });
    groupRepo.findOneBy.mockResolvedValue({
      id: GROUP_ID,
      severity: ErrorSeverity.ERROR,
      status: 'new',
      message: 'boom',
      occurrenceCount: 1,
    });

    await service.reportError({ message: 'boom' });

    expect(occurrenceRepo.createQueryBuilder).toHaveBeenCalledWith('o');
    expect(distinctUsers.select).toHaveBeenCalledWith('COUNT(DISTINCT o."userId")', 'count');
  });

  it('does not reload the alert rules on every error', async () => {
    // Error volume amplified database load one-for-one: a database-caused 5xx
    // storm produced more reads of the same database.
    const { service, ruleRepo } = await build();

    await service.reportError({ message: 'boom' });
    await service.reportError({ message: 'boom' });
    await service.reportError({ message: 'boom' });

    expect(ruleRepo.find).toHaveBeenCalledTimes(1);
  });

  it('reloads the rules after an operator changes one', async () => {
    const { service, ruleRepo } = await build();

    await service.reportError({ message: 'boom' });
    await service.deleteAlertRule('rule-1');
    await service.reportError({ message: 'boom' });

    expect(ruleRepo.find).toHaveBeenCalledTimes(2);
  });
});
