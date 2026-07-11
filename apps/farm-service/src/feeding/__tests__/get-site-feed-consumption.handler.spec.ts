/**
 * GetSiteFeedConsumptionHandler — real fed-amount ledger per feed type for a
 * site + period (replaces the frontend's old "daily plan × 30" estimate).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetSiteFeedConsumptionHandler } from '../query-handlers/get-site-feed-consumption.handler';
import { GetSiteFeedConsumptionQuery } from '../queries/get-site-feed-consumption.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

describe('GetSiteFeedConsumptionHandler', () => {
  it('sums actual fed amounts grouped by feed type', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('FROM feeding_records')) {
        return Promise.resolve([
          { feedName: 'Grower 4mm', brandName: 'Skretting', quantityKg: '1840.25', recordCount: '60' },
          { feedName: 'Starter 2mm', brandName: null, quantityKg: '120', recordCount: '12' },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await new GetSiteFeedConsumptionHandler(mockDataSource).execute(
      new GetSiteFeedConsumptionQuery(tenantId, siteId, '2026-06-01', '2026-06-30'),
    );

    expect(result.totalKg).toBeCloseTo(1960.25);
    expect(result.byFeedType).toEqual([
      { feedName: 'Grower 4mm', brandName: 'Skretting', quantityKg: 1840.25 },
      { feedName: 'Starter 2mm', brandName: undefined, quantityKg: 120 },
    ]);
    expect(result.recordCount).toBe(72);
  });

  it('returns a zero aggregate for a period with no feedings and parameterises inputs', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();

    const result = await new GetSiteFeedConsumptionHandler(mockDataSource).execute(
      new GetSiteFeedConsumptionQuery(tenantId, siteId, '2026-05-01', '2026-05-31'),
    );

    expect(result).toEqual({ totalKg: 0, byFeedType: [], recordCount: 0 });
    const call = (mockQueryRunner.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('FROM feeding_records'),
    );
    expect(call?.[1]).toEqual([tenantId, siteId, '2026-05-01', '2026-05-31']);
  });
});
