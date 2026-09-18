import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ActivityLog } from '../../entities/security.entity';
import { AuditTrailService } from '../audit-trail.service';

const MALICIOUS_SORT = 'createdAt) DESC; SELECT pg_sleep(1); --';

const createQueryBuilder = () => ({
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
});

describe('AuditTrailService sort safety', () => {
  let service: AuditTrailService;
  let queryBuilder: ReturnType<typeof createQueryBuilder>;

  beforeEach(async () => {
    queryBuilder = createQueryBuilder();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditTrailService,
        {
          provide: getRepositoryToken(ActivityLog),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
        },
      ],
    }).compile();

    service = module.get(AuditTrailService);
  });

  it('maps malicious direct service input to the static createdAt default', async () => {
    await service.getAuditTrail({ sortBy: MALICIOUS_SORT });

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('log.createdAt', 'DESC');
  });

  it.each([
    ['createdAt', 'log.createdAt'],
    ['severity', 'log.severity'],
    ['category', 'log.category'],
    ['action', 'log.action'],
    ['success', 'log.success'],
    ['duration', 'log.duration'],
  ])('maps allowed field %s to complete identifier %s', async (sortBy, expectedColumn) => {
    await service.getAuditTrail({ sortBy });

    expect(queryBuilder.orderBy).toHaveBeenCalledWith(expectedColumn, 'DESC');
  });

  it.each([
    ['asc', 'ASC'],
    ['AsC', 'ASC'],
    ['sideways', 'DESC'],
  ])('normalizes direct sort direction %s to %s', async (sortOrder, expectedOrder) => {
    await Reflect.apply(service.getAuditTrail, service, [{ sortOrder }]);

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('log.createdAt', expectedOrder);
  });

  it('keeps audit filters parameterized', async () => {
    await service.getAuditTrail({ actions: ['delete'] });

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('(log.action LIKE :action0)', {
      action0: '%delete%',
    });
  });
});
