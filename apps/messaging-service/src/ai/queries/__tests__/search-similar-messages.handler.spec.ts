import { of } from 'rxjs';
import { DataSource } from 'typeorm';

import {
  createMockDataSource,
  createMockNatsClient,
  createMockQueryRunner,
  fakeUuid,
  MockNatsClient,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { SearchSimilarMessagesHandler } from '../search-similar-messages.handler';
import { SearchSimilarMessagesQuery } from '../search-similar-messages.query';

describe('SearchSimilarMessagesHandler', () => {
  let handler: SearchSimilarMessagesHandler;
  let queryRunner: MockQueryRunner;
  let dataSource: ReturnType<typeof createMockDataSource>;
  let natsClient: MockNatsClient;
  let aiEgressGate: { assertAllowed: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = fakeUuid('usr');
  const channelId = fakeUuid('ch');

  beforeEach(() => {
    queryRunner = createMockQueryRunner();
    dataSource = createMockDataSource(queryRunner);
    natsClient = createMockNatsClient();
    natsClient.send.mockReturnValue(of({ embeddings: [[0.1, 0.2, 0.3]] }));
    aiEgressGate = { assertAllowed: jest.fn().mockResolvedValue(undefined) };

    handler = new SearchSimilarMessagesHandler(
      dataSource as unknown as DataSource,
      natsClient as never,
      aiEgressGate as never,
    );
  });

  it('pins search to tenant transaction and tenant-scopes membership plus vector SQL', async () => {
    const messageId = fakeUuid('msg');
    queryRunner.manager.query
      .mockResolvedValueOnce([{ channelId }])
      .mockResolvedValueOnce([
        {
          id: messageId,
          channelId,
          senderId: userId,
          content: 'feed note',
          contentType: 'text',
          createdAt: new Date('2026-03-10T12:00:00Z'),
          isDeleted: false,
          similarity: '0.91',
        },
      ]);

    const result = await handler.execute(
      new SearchSimilarMessagesQuery(tenantId, userId, 'feed', channelId, 10),
    );

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"tenant_aaaaaaaaaaaa4aaa", "messaging", public`],
    );
    expect(queryRunner.query).toHaveBeenCalledTimes(2);
    expect(aiEgressGate.assertAllowed).toHaveBeenCalledWith(
      tenantId,
      userId,
      'semantic-search',
    );

    const membershipSql = queryRunner.manager.query.mock.calls[0][0] as string;
    expect(membershipSql).toContain('FROM "channel_members"');
    expect(membershipSql).toContain('"tenantId" = $1::uuid');
    expect(queryRunner.manager.query.mock.calls[0][1]).toEqual([
      tenantId,
      userId,
      channelId,
    ]);

    const searchSql = queryRunner.manager.query.mock.calls[1][0] as string;
    expect(searchSql).toContain('FROM "messages" m');
    expect(searchSql).toContain('m."tenantId" = $2::uuid');
    expect(queryRunner.manager.query.mock.calls[1][1]).toEqual([
      '[0.1,0.2,0.3]',
      tenantId,
      [channelId],
      10,
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: messageId, channelId }),
        similarity: 0.91,
      }),
    ]);
  });
});
