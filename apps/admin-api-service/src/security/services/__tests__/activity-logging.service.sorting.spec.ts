import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ActivityLog,
  ApiUsageLog,
  LoginAttempt,
  UserSession,
} from '../../entities/security.entity';
import { ActivityLoggingService } from '../activity-logging.service';

/** ADMIN-HIGH-013: scheduled ticks run through the kernel runner; these suites exercise the bodies. */
const passThroughScheduledJobs: ScheduledJobExecutor = {
  run: async (_job, body) => {
    await body();
    return 'ran';
  },
};

const MALICIOUS_SORT = 'createdAt) DESC; SELECT pg_sleep(1); --';

const createQueryBuilder = () => ({
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
});

describe('ActivityLoggingService sort safety', () => {
  let service: ActivityLoggingService;
  let queryBuilder: ReturnType<typeof createQueryBuilder>;

  beforeEach(async () => {
    queryBuilder = createQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityLoggingService,
        { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
        {
          provide: getRepositoryToken(ActivityLog),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
        },
        { provide: getRepositoryToken(LoginAttempt), useValue: {} },
        { provide: getRepositoryToken(ApiUsageLog), useValue: {} },
        { provide: getRepositoryToken(UserSession), useValue: {} },
      ],
    }).compile();

    service = module.get(ActivityLoggingService);
  });

  it('maps malicious direct service input to the static createdAt default', async () => {
    await service.queryActivities({ sortBy: MALICIOUS_SORT });

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('activity.createdAt', 'DESC');
  });

  it.each([
    ['createdAt', 'activity.createdAt'],
    ['severity', 'activity.severity'],
    ['category', 'activity.category'],
    ['action', 'activity.action'],
    ['success', 'activity.success'],
    ['duration', 'activity.duration'],
  ])('maps allowed field %s to complete identifier %s', async (sortBy, expectedColumn) => {
    await service.queryActivities({ sortBy });

    expect(queryBuilder.orderBy).toHaveBeenCalledWith(expectedColumn, 'DESC');
  });

  it.each([
    ['asc', 'ASC'],
    ['AsC', 'ASC'],
    ['sideways', 'DESC'],
  ])('normalizes direct sort direction %s to %s', async (sortOrder, expectedOrder) => {
    await Reflect.apply(service.queryActivities, service, [{ sortOrder }]);

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('activity.createdAt', expectedOrder);
  });

  it('keeps activity filters parameterized', async () => {
    await service.queryActivities({ action: 'delete_%' });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('activity.action LIKE :action', {
      action: '%delete_%%',
    });
  });
});
