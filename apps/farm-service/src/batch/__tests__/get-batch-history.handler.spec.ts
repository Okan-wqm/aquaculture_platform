import { createMockDataSource } from '@aquaculture/testing';
import { NotFoundException } from '@nestjs/common';

import {
  BatchHistoryEventType,
  GetBatchHistoryQuery,
} from '../queries/get-batch-history.query';
import { GetBatchHistoryHandler } from '../query-handlers/get-batch-history.handler';

describe('GetBatchHistoryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('throws NotFoundException when the batch does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetBatchHistoryHandler(mockDataSource);
    await expect(
      handler.execute(new GetBatchHistoryQuery(tenantId, 'missing')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('includes a CREATED event for an existing batch read through the boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const batch = {
      id: 'batch-1',
      tenantId,
      batchNumber: 'B-2025-00001',
      speciesId: 'sp1',
      initialQuantity: 100,
      inputType: 'fingerling',
      createdAt: new Date('2025-01-01'),
      createdBy: 'u1',
      weight: { initial: { avgWeight: 2 } },
    };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(batch);
    // operations + allocations resolve to [] via the factory default mockManager.find

    const handler = new GetBatchHistoryHandler(mockDataSource);
    const result = await handler.execute(new GetBatchHistoryQuery(tenantId, 'batch-1'));

    expect(result.some((e) => e.eventType === BatchHistoryEventType.CREATED)).toBe(true);
  });
});
