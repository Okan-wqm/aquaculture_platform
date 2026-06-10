import { DataSource } from 'typeorm';

import { PartitionManagerService } from './partition-manager.service';

describe('PartitionManagerService', () => {
  it('fails closed when partition DDL fails unexpectedly', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(
          new Error('"messaging"."messages" is not partitioned'),
        ),
    } as unknown as DataSource;

    await expect(
      new PartitionManagerService(dataSource).onApplicationBootstrap(),
    ).rejects.toThrow('"messaging"."messages" is not partitioned');
  });
});
