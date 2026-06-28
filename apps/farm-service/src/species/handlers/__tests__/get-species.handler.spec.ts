import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetSpeciesQuery } from '../../queries/get-species.query';
import { GetSpeciesHandler } from '../get-species.handler';

describe('GetSpeciesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const speciesId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the species read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const species = { id: speciesId, tenantId };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(species);

    const handler = new GetSpeciesHandler(mockDataSource);
    const result = await handler.execute(new GetSpeciesQuery(tenantId, speciesId));

    expect(result).toBe(species);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: speciesId, tenantId },
    });
  });

  it('throws NotFoundException when no species matches the id', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSpeciesHandler(mockDataSource);

    await expect(
      handler.execute(new GetSpeciesQuery(tenantId, speciesId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
