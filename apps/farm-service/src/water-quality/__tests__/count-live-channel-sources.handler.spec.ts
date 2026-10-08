import { createMockDataSource } from '@aquaculture/testing';

import { CountLiveChannelSourcesQuery } from '../queries/parameter-source-queries';
import { CountLiveChannelSourcesHandler } from '../query-handlers/parameter-source-query.handlers';
import { liveChannelSourceCount } from '../services/parameter-sources';

jest.mock('../services/parameter-sources', () => ({
  ...jest.requireActual('../services/parameter-sources'),
  liveChannelSourceCount: jest.fn(),
}));

describe('CountLiveChannelSourcesHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const parameterConfigId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('counts with the rule the declare and config writers refuse on, inside the tenant read', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    jest.mocked(liveChannelSourceCount).mockResolvedValueOnce(2);

    const handler = new CountLiveChannelSourcesHandler(mockDataSource);
    const count = await handler.execute(
      new CountLiveChannelSourcesQuery(tenantId, parameterConfigId),
    );

    expect(count).toBe(2);
    expect(liveChannelSourceCount).toHaveBeenCalledWith(mockManager, tenantId, parameterConfigId);
  });
});
