import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetChemicalQuery } from '../../queries/get-chemical.query';
import { GetChemicalHandler } from '../../handlers/get-chemical.handler';

describe('GetChemicalHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const chemicalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the chemical read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const chemical = { id: chemicalId, tenantId, name: 'Chlorine' };
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(chemical);

    const handler = new GetChemicalHandler(mockDataSource);
    const result = await handler.execute(new GetChemicalQuery(chemicalId, tenantId));

    expect(result).toBe(chemical);
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: chemicalId, tenantId },
    });
  });

  it('throws NotFoundException when the chemical does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetChemicalHandler(mockDataSource);

    await expect(handler.execute(new GetChemicalQuery(chemicalId, tenantId))).rejects.toThrow(
      NotFoundException,
    );
  });
});
