import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetStorageLocationQuery } from '../queries/get-storage-location.query';
import { GetStorageLocationHandler } from '../handlers/get-storage-location.handler';

describe('GetStorageLocationHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const locationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the storage location read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: locationId });

    const handler = new GetStorageLocationHandler(mockDataSource);
    const result = await handler.execute(new GetStorageLocationQuery(locationId, tenantId));

    expect(result).toEqual({ id: locationId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: locationId, tenantId },
    });
  });

  it('throws NotFoundException when the location does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetStorageLocationHandler(mockDataSource);

    await expect(
      handler.execute(new GetStorageLocationQuery(locationId, tenantId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
