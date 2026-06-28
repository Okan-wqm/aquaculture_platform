import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetLatestMeasurementQuery } from '../queries/get-latest-measurement.query';
import { GetLatestMeasurementHandler } from '../query-handlers/get-latest-measurement.handler';

describe('GetLatestMeasurementHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the latest measurement read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock)
      .mockResolvedValueOnce({ id: batchId })
      .mockResolvedValueOnce({ id: 'gm-latest', batchId });

    const handler = new GetLatestMeasurementHandler(mockDataSource);
    const result = await handler.execute(new GetLatestMeasurementQuery(tenantId, batchId));

    expect(result).toEqual({ id: 'gm-latest', batchId });
    expect(mockManager.findOne).toHaveBeenNthCalledWith(2, expect.anything(), {
      where: { tenantId, batchId },
      order: { measurementDate: 'DESC' },
      relations: ['batch'],
    });
  });

  it('throws NotFoundException when the batch does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetLatestMeasurementHandler(mockDataSource);

    await expect(
      handler.execute(new GetLatestMeasurementQuery(tenantId, batchId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
