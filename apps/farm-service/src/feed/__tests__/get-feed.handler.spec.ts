import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetFeedQuery } from '../queries/get-feed.query';
import { GetFeedHandler } from '../handlers/get-feed.handler';

describe('GetFeedHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const feedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns the feed read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: feedId, tenantId });

    const handler = new GetFeedHandler(mockDataSource);
    const result = await handler.execute(new GetFeedQuery(feedId, tenantId));

    expect(result).toEqual({ id: feedId, tenantId });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: feedId, tenantId },
    });
  });

  it('throws NotFoundException when the feed does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetFeedHandler(mockDataSource);

    await expect(handler.execute(new GetFeedQuery(feedId, tenantId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
