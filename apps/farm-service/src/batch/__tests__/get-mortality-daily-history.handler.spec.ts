/**
 * GetMortalityDailyHistoryHandler — fail-closed tenant boundary + the
 * per-day GROUP BY shape the health page chart consumes.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetMortalityDailyHistoryHandler } from '../query-handlers/get-mortality-daily-history.handler';
import { GetMortalityDailyHistoryQuery } from '../queries/get-mortality-daily-history.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('GetMortalityDailyHistoryHandler', () => {
  it('groups per day scoped to the tenant window and coerces bigint counts', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    const rows = [
      { date: '2026-10-18', count: '412' },
      { date: '2026-10-19', count: '236' },
    ];
    // runInTenantRead issues its own queryRunner.query calls (SET READ ONLY,
    // search_path pin, context assert) before fn() — answer by SQL shape.
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) =>
      sql.includes('mortality_records') ? Promise.resolve(rows) : Promise.resolve([]),
    );

    const result = await new GetMortalityDailyHistoryHandler(mockDataSource).execute(
      new GetMortalityDailyHistoryQuery(tenantId, 14),
    );

    expect(result).toEqual([
      { date: '2026-10-18', count: 412 },
      { date: '2026-10-19', count: 236 },
    ]);
    const call = (mockQueryRunner.query as jest.Mock).mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('mortality_records'),
    );
    expect(call).toBeDefined();
    expect(call[0]).toContain('GROUP BY mr."recordDate"');
    expect(call[1]).toEqual([tenantId, 14]);
  });
});
