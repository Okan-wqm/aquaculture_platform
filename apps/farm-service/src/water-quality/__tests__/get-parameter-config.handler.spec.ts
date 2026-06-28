import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetParameterConfigQuery } from '../queries/get-parameter-config.query';
import { GetParameterConfigHandler } from '../query-handlers/get-parameter-config.handler';

describe('GetParameterConfigHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const configId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the parameter config read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: configId, tenantId });

    const handler = new GetParameterConfigHandler(mockDataSource);
    const result = await handler.execute(new GetParameterConfigQuery(tenantId, configId));

    expect(result).toEqual({ id: configId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: configId, tenantId },
    });
  });

  it('throws NotFoundException when the config does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetParameterConfigHandler(mockDataSource);

    await expect(
      handler.execute(new GetParameterConfigQuery(tenantId, configId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
