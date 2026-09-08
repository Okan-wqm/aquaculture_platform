import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';

import {
  BackgroundJob,
  JobExecutionLog,
  JobQueue,
  JobStatus,
} from '../../entities/job-queue.entity';
import { JobQueueService } from '../job-queue.service';

/**
 * ADMIN-HIGH-013 — a background job is claimed inside one locked transaction
 * (`FOR UPDATE SKIP LOCKED` + the RUNNING transition), so two replicas or two
 * overlapping ticks can never execute the same row.
 */
const passThroughScheduledJobs: ScheduledJobExecutor = {
  run: async (_job, body) => {
    await body();
    return 'ran';
  },
};

interface QueryBuilderCalls {
  setLock: jest.Mock;
  setOnLocked: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getMany: jest.Mock;
}

function queryBuilder(candidates: BackgroundJob[]): QueryBuilderCalls {
  const qb: Partial<QueryBuilderCalls> = {};
  const chain = (): QueryBuilderCalls => qb as QueryBuilderCalls;
  qb.setLock = jest.fn(chain);
  qb.setOnLocked = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.addOrderBy = jest.fn(chain);
  qb.take = jest.fn(chain);
  qb.getMany = jest.fn().mockResolvedValue(candidates);
  return qb as QueryBuilderCalls;
}

function job(overrides: Partial<BackgroundJob>): BackgroundJob {
  return Object.assign(new BackgroundJob(), {
    id: 'job-1',
    name: 'send-digest',
    queueName: 'default',
    status: JobStatus.PENDING,
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  });
}

describe('JobQueueService.claimReadyJobs (ADMIN-HIGH-013)', () => {
  const jobRepo = {
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const logRepo = { create: jest.fn((v: unknown) => v), save: jest.fn() };
  const queueRepo = { find: jest.fn(), update: jest.fn() };
  const manager = { createQueryBuilder: jest.fn(), count: jest.fn(), save: jest.fn() };
  /** Status + attempts at the moment of each save — the row is mutated again after execution. */
  const savedStates: Array<{ id: string; status: JobStatus; attempts: number }> = [];
  const dataSource = {
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
  };

  async function service(): Promise<JobQueueService> {
    const module = await Test.createTestingModule({
      providers: [
        JobQueueService,
        { provide: getRepositoryToken(BackgroundJob), useValue: jobRepo },
        { provide: getRepositoryToken(JobExecutionLog), useValue: logRepo },
        { provide: getRepositoryToken(JobQueue), useValue: queueRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
      ],
    }).compile();
    return module.get(JobQueueService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    savedStates.length = 0;
    manager.save.mockImplementation(async (_entity: unknown, value: BackgroundJob) => {
      savedStates.push({ id: value.id, status: value.status, attempts: value.attempts });
      return value;
    });
    manager.count.mockResolvedValue(0);
    queueRepo.find.mockResolvedValue([
      { name: 'default', concurrency: 2, isActive: true, isPaused: false },
    ]);
  });

  it('selects candidates FOR UPDATE SKIP LOCKED and moves them to RUNNING inside the claiming transaction', async () => {
    const svc = await service();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    svc.registerHandler('send-digest', handler);
    const qb = queryBuilder([job({ id: 'job-1' })]);
    manager.createQueryBuilder.mockReturnValue(qb);

    await svc.processJobs();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(qb.setOnLocked).toHaveBeenCalledWith('skip_locked');
    expect(qb.take).toHaveBeenCalledWith(2);
    expect(savedStates).toEqual([{ id: 'job-1', status: JobStatus.RUNNING, attempts: 1 }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('leaves a job whose dependencies are still open, and one this process cannot run, unclaimed', async () => {
    const svc = await service();
    svc.registerHandler('send-digest', jest.fn().mockResolvedValue({}));
    const blocked = job({ id: 'blocked', dependencies: ['dep-1'] });
    const foreign = job({ id: 'foreign', name: 'no-handler-here' });
    manager.createQueryBuilder.mockReturnValue(queryBuilder([blocked, foreign]));
    manager.count.mockResolvedValue(1);

    await svc.processJobs();

    expect(manager.count).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
    expect(blocked.status).toBe(JobStatus.PENDING);
    expect(foreign.status).toBe(JobStatus.PENDING);
  });

  it('does not claim when the queue is already at its concurrency limit', async () => {
    const svc = await service();
    jobRepo.count.mockResolvedValueOnce(2);

    await svc.processJobs();

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
