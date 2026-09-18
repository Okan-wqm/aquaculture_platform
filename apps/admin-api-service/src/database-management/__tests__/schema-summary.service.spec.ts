/**
 * The platform-wide schema totals are an aggregate over every row
 * (ADMIN-HIGH-132).
 *
 * `DatabaseManagementPage` computed all four of its "Total …" cards in the
 * browser by reducing over `getSchemas({ page: 1, limit: 100 })`. The server
 * has owned the aggregate all along; it just did not carry the table count,
 * and it materialised every schema record into Node to add up two integers.
 *
 * Two properties are asserted here because they are the ones the page depends
 * on and neither is visible from the call site:
 *   1. the totals come from ONE aggregate query, not from `find()` — a repo
 *      whose `find` throws still produces a summary;
 *   2. `size_bytes` is a bigint, so the driver returns a STRING, and a summary
 *      that forgets to coerce it silently concatenates ("40961024" for two
 *      schemas) instead of summing.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';

import { TenantSchema } from '../entities/database-management.entity';
import { SchemaManagementService } from '../services/schema-management.service';

describe('SchemaManagementService.getSchemaSummary', () => {
  let service: SchemaManagementService;
  let getRawOne: jest.Mock;
  let find: jest.Mock;

  beforeEach(async () => {
    getRawOne = jest.fn();
    find = jest.fn(() => {
      throw new Error('getSchemaSummary must not materialise every schema row');
    });

    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawOne,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaManagementService,
        // `useValue` takes the double as-is — no cast. A `as unknown as
        // Repository<TenantSchema>` here would type-check nothing, so the
        // double could drift from the repository API and this suite would go
        // green for the wrong reason.
        {
          provide: getRepositoryToken(TenantSchema),
          useValue: { find, createQueryBuilder: jest.fn(() => queryBuilder) },
        },
        {
          provide: getDataSourceToken(),
          useValue: {},
        },
      ],
    }).compile();

    service = module.get(SchemaManagementService);
  });

  it('sums the estate from one aggregate rather than loading every row', async () => {
    getRawOne.mockResolvedValue({
      totalSchemas: '412',
      activeSchemas: '380',
      suspendedSchemas: '32',
      totalSizeBytes: '5368709120',
      totalTableCount: '9744',
    });

    await expect(service.getSchemaSummary()).resolves.toEqual({
      totalSchemas: 412,
      activeSchemas: 380,
      suspendedSchemas: 32,
      totalSizeBytes: 5368709120,
      totalTableCount: 9744,
      avgSizeBytes: 13030847,
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('coerces the bigint strings the driver returns instead of concatenating them', async () => {
    getRawOne.mockResolvedValue({
      totalSchemas: '2',
      activeSchemas: '2',
      suspendedSchemas: '0',
      totalSizeBytes: '5120',
      totalTableCount: '17',
    });

    const summary = await service.getSchemaSummary();

    expect(summary.totalSizeBytes).toBe(5120);
    expect(typeof summary.totalSizeBytes).toBe('number');
    expect(summary.avgSizeBytes).toBe(2560);
  });

  it('reports zeros for an empty estate rather than dividing by zero', async () => {
    getRawOne.mockResolvedValue({
      totalSchemas: '0',
      activeSchemas: '0',
      suspendedSchemas: '0',
      totalSizeBytes: '0',
      totalTableCount: '0',
    });

    await expect(service.getSchemaSummary()).resolves.toEqual({
      totalSchemas: 0,
      activeSchemas: 0,
      suspendedSchemas: 0,
      totalSizeBytes: 0,
      totalTableCount: 0,
      avgSizeBytes: 0,
    });
  });
});
