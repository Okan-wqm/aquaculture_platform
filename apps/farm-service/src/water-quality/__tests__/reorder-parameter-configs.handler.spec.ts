/**
 * ReorderParameterConfigsHandler Unit Tests
 *
 * Verifies the tenant-scoped transactional contract: per-id displayOrder
 * updates inside runInTenantTransaction, post-commit cache invalidation,
 * and the post-commit sorted read used for the return value.
 */
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { ReorderParameterConfigsCommand } from '../commands/reorder-parameter-configs.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ReorderParameterConfigsHandler } from '../handlers/reorder-parameter-configs.handler';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

describe('ReorderParameterConfigsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const orderedIds = [
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];

  function setup(): {
    handler: ReorderParameterConfigsHandler;
    mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
    mockQueryRunner: ReturnType<typeof createMockDataSource>['mockQueryRunner'];
    configRepository: ReturnType<typeof createMockRepository<WaterQualityParameterConfig>>;
    invalidate: jest.SpyInstance<void, [string]>;
  } {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const configRepository = createMockRepository<WaterQualityParameterConfig>();
    const configCache = new ParameterConfigCacheService(
      createMockRepository<WaterQualityParameterConfig>(),
    );
    const invalidate = jest.spyOn(configCache, 'invalidate').mockImplementation(() => undefined);

    const handler = new ReorderParameterConfigsHandler(
      configRepository,
      mockDataSource,
      configCache,
    );

    return { handler, mockManager, mockQueryRunner, configRepository, invalidate };
  }

  it('updates displayOrder for each id inside the tenant transaction and returns the sorted configs', async () => {
    const { handler, mockManager, mockQueryRunner, configRepository, invalidate } = setup();
    const sorted = [
      { id: orderedIds[0], tenantId, displayOrder: 1 },
      { id: orderedIds[1], tenantId, displayOrder: 2 },
    ] as WaterQualityParameterConfig[];
    configRepository.find.mockResolvedValueOnce(sorted);

    const result = await handler.execute(
      new ReorderParameterConfigsCommand(tenantId, orderedIds),
    );

    expect(result).toEqual(sorted);
    expect(mockManager.update).toHaveBeenCalledTimes(orderedIds.length);
    expect(mockManager.update).toHaveBeenNthCalledWith(
      1,
      WaterQualityParameterConfig,
      { id: orderedIds[0], tenantId },
      { displayOrder: 1 },
    );
    expect(mockManager.update).toHaveBeenNthCalledWith(
      2,
      WaterQualityParameterConfig,
      { id: orderedIds[1], tenantId },
      { displayOrder: 2 },
    );
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    // post-commit side effect runs after the transaction
    expect(invalidate).toHaveBeenCalledWith(tenantId);
  });
});
