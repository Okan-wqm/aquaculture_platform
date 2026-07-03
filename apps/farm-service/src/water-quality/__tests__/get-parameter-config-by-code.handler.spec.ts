import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetParameterConfigByCodeQuery } from '../queries/get-parameter-config-by-code.query';
import { GetParameterConfigByCodeHandler } from '../query-handlers/get-parameter-config-by-code.handler';

describe('GetParameterConfigByCodeHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const code = 'DO';

  it('returns the parameter config by code read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'cfg-1', code, tenantId });

    const handler = new GetParameterConfigByCodeHandler(mockDataSource);
    const result = await handler.execute(new GetParameterConfigByCodeQuery(tenantId, code));

    expect(result).toEqual({ id: 'cfg-1', code, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { code, tenantId },
    });
  });

  it('throws NotFoundException when no config matches the code', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetParameterConfigByCodeHandler(mockDataSource);

    await expect(
      handler.execute(new GetParameterConfigByCodeQuery(tenantId, code)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
