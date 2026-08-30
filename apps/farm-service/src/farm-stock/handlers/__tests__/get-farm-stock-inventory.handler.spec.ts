import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { createMockDataSource } from '@aquaculture/testing';

const runInTenantReadMock = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (
    dataSource: DataSource,
    schema: string,
    tenantId: string,
    callback: (queryRunner: QueryRunner) => Promise<unknown>,
  ) => runInTenantReadMock(dataSource, schema, tenantId, callback),
}));

import { FarmStockBatchSnapshot } from '../../entities/farm-stock-batch-snapshot.entity';
import {
  FarmStockContainerSnapshot,
  FarmStockContainerSource,
} from '../../entities/farm-stock-container-snapshot.entity';
import { GetFarmStockInventoryQuery } from '../../queries/get-farm-stock-inventory.query';
import { GetFarmStockInventoryHandler } from '../get-farm-stock-inventory.handler';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function container(containerId: string, name: string): FarmStockContainerSnapshot {
  return Object.assign(new FarmStockContainerSnapshot(), {
    id: containerId,
    tenantId: TENANT_ID,
    containerId,
    containerSource: FarmStockContainerSource.TANK,
    name,
    code: name.toUpperCase(),
    isOverCapacity: false,
    hasActiveBatch: true,
    isActive: true,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

function batch(containerId: string): FarmStockBatchSnapshot {
  return Object.assign(new FarmStockBatchSnapshot(), {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantId: TENANT_ID,
    containerId,
    batchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    batchNumber: 'BATCH-1',
    quantity: 100,
    biomassKg: 25,
    avgWeightG: 250,
    totalMortality: 0,
    totalCull: 0,
    harvestedQuantity: 0,
    isPrimary: true,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

describe('GetFarmStockInventoryHandler pagination contract', () => {
  let manager: jest.Mocked<EntityManager>;
  let queryRunner: jest.Mocked<QueryRunner>;
  let dataSource: jest.Mocked<DataSource>;
  let handler: GetFarmStockInventoryHandler;

  beforeEach(() => {
    const mocks = createMockDataSource();
    manager = mocks.mockManager;
    queryRunner = mocks.mockQueryRunner;
    dataSource = mocks.mockDataSource;
    runInTenantReadMock.mockReset();
    runInTenantReadMock.mockImplementation(
      async (
        _dataSource: DataSource,
        _schema: string,
        _tenantId: string,
        callback: (scopedQueryRunner: QueryRunner) => Promise<unknown>,
      ) => callback(queryRunner),
    );
    handler = new GetFarmStockInventoryHandler(dataSource);
  });

  function installInventoryQuery(
    total: number,
    containers: FarmStockContainerSnapshot[],
  ): {
    skip: jest.Mock;
    take: jest.Mock;
  } {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(total),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(containers),
    };
    manager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilder) as typeof manager.createQueryBuilder;
    return queryBuilder;
  }

  it('returns the standard empty-page semantics without querying batch snapshots', async () => {
    const queryBuilder = installInventoryQuery(0, []);

    const result = await handler.execute(
      new GetFarmStockInventoryQuery(TENANT_ID, { page: 1, limit: 25 }),
    );

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 25,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    expect(queryBuilder.skip).toHaveBeenCalledWith(0);
    expect(queryBuilder.take).toHaveBeenCalledWith(25);
    expect(manager.find).not.toHaveBeenCalled();
    expect(runInTenantReadMock).toHaveBeenCalledWith(
      dataSource,
      'farm',
      TENANT_ID,
      expect.any(Function),
    );
  });

  it('derives multi-page navigation flags from the shared pagination authority', async () => {
    const firstContainer = container('11111111-1111-4111-8111-111111111111', 'Alpha');
    const secondContainer = container('22222222-2222-4222-8222-222222222222', 'Beta');
    const primaryBatch = batch(firstContainer.containerId);
    const queryBuilder = installInventoryQuery(5, [firstContainer, secondContainer]);
    manager.find.mockResolvedValue([primaryBatch]);

    const result = await handler.execute(
      new GetFarmStockInventoryQuery(TENANT_ID, { page: 2, limit: 2 }),
    );

    expect(result).toMatchObject({
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(result.items).toEqual([
      { container: firstContainer, batches: [primaryBatch] },
      { container: secondContainer, batches: [] },
    ]);
    expect(queryBuilder.skip).toHaveBeenCalledWith(2);
    expect(queryBuilder.take).toHaveBeenCalledWith(2);
  });
});
