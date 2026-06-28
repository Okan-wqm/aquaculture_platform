import { createMockDataSource } from '@aquaculture/testing';
import { NotFoundException } from '@nestjs/common';

import { GetPondQuery } from '../queries/get-pond.query';
import { GetPondQueryHandler } from '../query-handlers/get-pond.handler';

describe('GetPondQueryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('returns the pond read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const pond = { id: 'pond-1', tenantId };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(pond);

    const handler = new GetPondQueryHandler(mockDataSource);
    const result = await handler.execute(new GetPondQuery('pond-1', tenantId));

    expect(result).toBe(pond);
  });

  it('includes batches by default and the farm relation when requested', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'pond-1', tenantId });

    const handler = new GetPondQueryHandler(mockDataSource);
    await handler.execute(new GetPondQuery('pond-1', tenantId, true, true));

    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'pond-1', tenantId },
      relations: ['batches', 'farm'],
    });
  });

  it('throws NotFoundException when the pond does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetPondQueryHandler(mockDataSource);
    await expect(
      handler.execute(new GetPondQuery('missing', tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
