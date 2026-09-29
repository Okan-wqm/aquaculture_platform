/**
 * GetSentimentTrendsHandler — K10 layer 5 (PR-T1, MT-HIGH-062): the aggregate
 * over AI-produced analysis rows is read inside the request tenant's boundary
 * and every table is filtered by that tenant.
 *
 * The DataSource double has NO members: an ambient `dataSource.query` throws.
 */
import { collaborator } from '@aquaculture/testing';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import type { DataSource } from 'typeorm';

import { GetSentimentTrendsHandler } from '../get-sentiment-trends.handler';
import { GetSentimentTrendsQuery } from '../get-sentiment-trends.query';

const queryRunner = { query: jest.fn() };

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: jest.fn(
      (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
        Promise.resolve(fn(queryRunner)),
    ),
  };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

describe('GetSentimentTrendsHandler — tenant-bound aggregate (K10 layer 5)', () => {
  const dataSource = collaborator<DataSource>({}, 'DataSource');
  const handler = new GetSentimentTrendsHandler(dataSource);
  const tenantRead = jest.mocked(runInTenantRead);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads inside the request tenant boundary and filters every joined table by that tenant', async () => {
    // SCENARIO: a tenant admin asks for four weeks of trends across all channels.
    // EXPECTS: one runInTenantRead for the tenant; analysis, message and channel rows are
    //          each constrained to it ($1); the week window is $2.
    queryRunner.query.mockResolvedValueOnce([]);

    await handler.execute(new GetSentimentTrendsQuery(TENANT, null, 4));

    expect(tenantRead).toHaveBeenCalledWith(dataSource, 'messaging', TENANT, expect.any(Function));
    const [sql, params] = queryRunner.query.mock.calls[0] ?? [];
    expect(sql).toContain('ma."tenantId" = $1');
    expect(sql).toContain('m."tenantId" = $1');
    expect(sql).toContain('c."tenantId" = $1');
    expect(params).toEqual([TENANT, expect.any(Date)]);
  });

  it('adds the channel filter as $3 after the tenant and window parameters', async () => {
    queryRunner.query.mockResolvedValueOnce([]);

    await handler.execute(new GetSentimentTrendsQuery(TENANT, CHANNEL, 4));

    const [sql, params] = queryRunner.query.mock.calls[0] ?? [];
    expect(sql).toContain('m."channelId" = $3');
    expect(params).toEqual([TENANT, expect.any(Date), CHANNEL]);
  });

  it('derives the week-over-week trend from the rows it read', async () => {
    // SCENARIO: two weeks for one channel, newest first, score rising by 0.2.
    // EXPECTS: the newest week is `improving`, the older one `stable`.
    queryRunner.query.mockResolvedValueOnce([
      {
        channelId: CHANNEL,
        channelName: 'Hatchery',
        weekStart: new Date('2026-09-21T00:00:00Z'),
        avgScore: '0.8',
        messageCount: '12',
      },
      {
        channelId: CHANNEL,
        channelName: 'Hatchery',
        weekStart: new Date('2026-09-14T00:00:00Z'),
        avgScore: '0.6',
        messageCount: '9',
      },
    ]);

    const trends = await handler.execute(new GetSentimentTrendsQuery(TENANT, null, 4));

    expect(trends.map((t) => [t.weekStart, t.trend, t.messageCount])).toEqual([
      ['2026-09-21T00:00:00.000Z', 'improving', 12],
      ['2026-09-14T00:00:00.000Z', 'stable', 9],
    ]);
  });
});
