import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ErrorAlertRule, ErrorGroup, ErrorOccurrence } from '../../entities/error-tracking.entity';
import { ErrorTrackingService } from '../error-tracking.service';

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

describe('ErrorTrackingService sort safety', () => {
  let service: ErrorTrackingService;
  let queryBuilder: ReturnType<typeof createQueryBuilder>;

  beforeEach(async () => {
    queryBuilder = createQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ErrorTrackingService,
        { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
        { provide: getRepositoryToken(ErrorOccurrence), useValue: {} },
        {
          provide: getRepositoryToken(ErrorGroup),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
        },
        { provide: getRepositoryToken(ErrorAlertRule), useValue: {} },
      ],
    }).compile();

    service = module.get(ErrorTrackingService);
  });

  it('maps malicious direct service input to the static lastSeenAt default', async () => {
    await Reflect.apply(service.queryErrorGroups, service, [{ sortBy: MALICIOUS_SORT }]);

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('g.lastSeenAt', 'DESC');
  });

  it.each([
    ['occurrenceCount', 'g.occurrenceCount'],
    ['lastSeenAt', 'g.lastSeenAt'],
    ['firstSeenAt', 'g.firstSeenAt'],
    ['userCount', 'g.userCount'],
  ] as const)('maps allowed field %s to complete identifier %s', async (sortBy, expectedColumn) => {
    await service.queryErrorGroups({ sortBy });

    expect(queryBuilder.orderBy).toHaveBeenCalledWith(expectedColumn, 'DESC');
  });

  it.each([
    ['asc', 'ASC'],
    ['AsC', 'ASC'],
    ['sideways', 'DESC'],
  ])('normalizes direct sort direction %s to %s', async (sortOrder, expectedOrder) => {
    await Reflect.apply(service.queryErrorGroups, service, [{ sortOrder }]);

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('g.lastSeenAt', expectedOrder);
  });

  it('keeps error-group filters parameterized', async () => {
    await service.queryErrorGroups({ search: "x%' OR 1=1 --" });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(g.message ILIKE :search OR g.errorType ILIKE :search OR g.culprit ILIKE :search)',
      { search: "%x%' OR 1=1 --%" },
    );
  });
});
