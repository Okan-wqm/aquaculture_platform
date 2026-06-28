import { createMockDataSource } from '@aquaculture/testing';

import { GetFeedingProtocolQuery } from '../queries/get-feeding-protocol.query';
import { GetFeedingProtocolHandler } from '../handlers/get-feeding-protocol.handler';

describe('GetFeedingProtocolHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const protocolId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the feeding protocol read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: protocolId, tenantId });

    const handler = new GetFeedingProtocolHandler(mockDataSource);
    const result = await handler.execute(new GetFeedingProtocolQuery(protocolId, tenantId));

    expect(result).toEqual({ id: protocolId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: protocolId, tenantId },
      relations: ['feed'],
    });
  });

  it('returns null when the feeding protocol does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetFeedingProtocolHandler(mockDataSource);
    const result = await handler.execute(new GetFeedingProtocolQuery(protocolId, tenantId));

    expect(result).toBeNull();
  });
});
