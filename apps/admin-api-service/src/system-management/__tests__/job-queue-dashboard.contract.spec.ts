/**
 * APA-281 (RC-4) — the job dashboard response shape must match what JobQueuePage
 * reads, so the Queues tab and the stat cards render real values.
 *
 * Before the fix getJobDashboard() returned {failedJobs, queueStats,
 * failedJobsList, scheduledJobs, ...} — none of which the FE read — so
 * dashboard.queues was undefined (empty Queues tab, dead Pause/Resume) and the
 * Failed card was blank. This pins the canonical contract: `queues` carries the
 * management shape (isPaused + concurrency + live counts) and the stat fields
 * are the canonical failedLast24h/completedLast24h/avgProcessingTime.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  BackgroundJob,
  JobExecutionLog,
  JobQueue,
} from '../entities/job-queue.entity';
import { JobQueueService } from '../services/job-queue.service';

describe('JobQueueService.getJobDashboard — FE contract (APA-281)', () => {
  let service: JobQueueService;

  const mockQueueRow = {
    name: 'default',
    isPaused: true,
    concurrency: 4,
    pendingCount: 7,
    runningCount: 2,
    completedCount: 120,
    failedCount: 3,
  };

  beforeEach(async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ avg: '512.5' }),
    };

    const mockJobRepo = {
      count: jest.fn().mockResolvedValue(9),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    const mockQueueRepo = {
      find: jest.fn().mockResolvedValue([mockQueueRow]),
    };

    const mockLogRepo = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobQueueService,
        { provide: getRepositoryToken(BackgroundJob), useValue: mockJobRepo },
        { provide: getRepositoryToken(JobExecutionLog), useValue: mockLogRepo },
        { provide: getRepositoryToken(JobQueue), useValue: mockQueueRepo },
      ],
    }).compile();

    service = module.get<JobQueueService>(JobQueueService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns exactly the canonical JobDashboardDto key set', async () => {
    const dashboard = await service.getJobDashboard();

    expect(Object.keys(dashboard).sort()).toEqual(
      [
        'avgProcessingTime',
        'completedLast24h',
        'failedLast24h',
        'pendingJobs',
        'queues',
        'recentJobs',
        'runningJobs',
        'totalJobs',
      ].sort(),
    );
  });

  it('drops the FE-dead drift fields (queueStats/failedJobsList/scheduledJobs/failedJobs)', async () => {
    const dashboard = await service.getJobDashboard();
    const keys = Object.keys(dashboard);

    expect(keys).not.toContain('queueStats');
    expect(keys).not.toContain('failedJobsList');
    expect(keys).not.toContain('scheduledJobs');
    expect(keys).not.toContain('failedJobs');
  });

  it('maps queues into the management shape the Queues tab renders', async () => {
    const dashboard = await service.getJobDashboard();

    expect(dashboard.queues).toHaveLength(1);
    const queue = dashboard.queues[0];
    expect(queue).toEqual({
      name: 'default',
      isPaused: true,
      concurrency: 4,
      pendingCount: 7,
      runningCount: 2,
      completedCount: 120,
      failedCount: 3,
    });
  });

  it('exposes the canonical numeric stats the cards read', async () => {
    const dashboard = await service.getJobDashboard();

    expect(typeof dashboard.failedLast24h).toBe('number');
    expect(typeof dashboard.completedLast24h).toBe('number');
    expect(dashboard.avgProcessingTime).toBeCloseTo(512.5);
  });
});
