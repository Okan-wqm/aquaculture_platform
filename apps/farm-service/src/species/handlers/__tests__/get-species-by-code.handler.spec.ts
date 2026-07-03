import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetSpeciesByCodeQuery } from '../../queries/get-species-by-code.query';
import { GetSpeciesByCodeHandler } from '../get-species-by-code.handler';

describe('GetSpeciesByCodeHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const speciesId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the species read through the tenant boundary, uppercasing the code', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const species = { id: speciesId, tenantId, code: 'SALM' };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(species);

    const handler = new GetSpeciesByCodeHandler(mockDataSource);
    const result = await handler.execute(new GetSpeciesByCodeQuery(tenantId, 'salm'));

    expect(result).toBe(species);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { tenantId, code: 'SALM' },
    });
  });

  it('throws NotFoundException when no species matches the code', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetSpeciesByCodeHandler(mockDataSource);

    await expect(
      handler.execute(new GetSpeciesByCodeQuery(tenantId, 'nope')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
