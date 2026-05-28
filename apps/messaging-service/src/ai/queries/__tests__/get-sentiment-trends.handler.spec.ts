import { DataSource } from 'typeorm';

import {
  createMockDataSource,
  createMockQueryRunner,
  fakeUuid,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { GetSentimentTrendsHandler } from '../get-sentiment-trends.handler';
import { GetSentimentTrendsQuery } from '../get-sentiment-trends.query';

describe('GetSentimentTrendsHandler', () => {
  let handler: GetSentimentTrendsHandler;
  let queryRunner: MockQueryRunner;
  let dataSource: ReturnType<typeof createMockDataSource>;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');

  beforeEach(() => {
    queryRunner = createMockQueryRunner();
    dataSource = createMockDataSource(queryRunner);
    handler = new GetSentimentTrendsHandler(dataSource as unknown as DataSource);
  });

  it('runs aggregate trend SQL inside tenant transaction with tenant predicates', async () => {
    queryRunner.manager.query.mockResolvedValue([
      {
        channelId,
        channelName: 'General',
        weekStart: new Date('2026-03-09T00:00:00Z'),
        avgScore: '0.82',
        messageCount: '7',
      },
    ]);

    const result = await handler.execute(
      new GetSentimentTrendsQuery(tenantId, channelId, 4),
    );

    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"tenant_aaaaaaaaaaaa4aaa", "messaging", public`],
    );

    const [sql, params] = queryRunner.manager.query.mock.calls[0];
    expect(sql).toContain('ma."tenantId" = $1::uuid');
    expect(sql).toContain('AND m."tenantId" = $1::uuid');
    expect(sql).toContain('AND c."tenantId" = $1::uuid');
    expect(sql).toContain('AND m."channelId" = $3::uuid');
    expect(params[0]).toBe(tenantId);
    expect(params[2]).toBe(channelId);
    expect(result).toEqual([
      expect.objectContaining({
        channelId,
        channelName: 'General',
        avgScore: 0.82,
        messageCount: 7,
      }),
    ]);
  });
});
