/**
 * GetMortalityByCauseHandler — site+period mortality GROUP BY cause through
 * the fail-closed tenant boundary. Numeric strings from pg come back as
 * numbers; the record count feeds provenance.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetMortalityByCauseHandler } from '../../query-handlers/get-mortality-by-cause.handler';
import { GetMortalityByCauseQuery } from '../../queries/get-mortality-by-cause.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

describe('GetMortalityByCauseHandler', () => {
  it('aggregates by cause with details and record count', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY mr.cause')) {
        return Promise.resolve([
          { cause: 'disease', count: '120' },
          { cause: 'oxygen', count: '30' },
        ]);
      }
      if (sql.includes('GROUP BY mr."recordDate"')) {
        return Promise.resolve([
          {
            date: '2026-06-03',
            cause: 'disease',
            speciesCode: 'SEABASS',
            count: '120',
            biomassLossKg: '84.5',
          },
          {
            date: '2026-06-10',
            cause: 'oxygen',
            speciesCode: 'SEABASS',
            count: '30',
            biomassLossKg: null,
          },
        ]);
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ recordCount: '7' }]);
      }
      return Promise.resolve([]);
    });

    const result = await new GetMortalityByCauseHandler(mockDataSource).execute(
      new GetMortalityByCauseQuery(tenantId, siteId, '2026-06-01', '2026-06-30'),
    );

    expect(result.totalCount).toBe(150);
    expect(result.byCause).toEqual([
      { cause: 'disease', count: 120 },
      { cause: 'oxygen', count: 30 },
    ]);
    expect(result.details[1]).toEqual({
      date: '2026-06-10',
      cause: 'oxygen',
      speciesCode: 'SEABASS',
      count: 30,
      biomassLossKg: undefined,
    });
    expect(result.recordCount).toBe(7);
  });

  it('passes tenant + site + period as parameters (no string interpolation)', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();

    await new GetMortalityByCauseHandler(mockDataSource).execute(
      new GetMortalityByCauseQuery(tenantId, siteId, '2026-06-01', '2026-06-30'),
    );

    const aggregateCall = (mockQueryRunner.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('GROUP BY mr.cause'),
    );
    expect(aggregateCall).toBeDefined();
    expect(aggregateCall?.[1]).toEqual([tenantId, siteId, '2026-06-01', '2026-06-30']);
    expect(String(aggregateCall?.[0])).not.toContain(tenantId);
  });

  it('returns an empty aggregate for a period with no records', async () => {
    const { mockDataSource } = createMockDataSource();

    const result = await new GetMortalityByCauseHandler(mockDataSource).execute(
      new GetMortalityByCauseQuery(tenantId, siteId, '2026-05-01', '2026-05-31'),
    );

    expect(result).toEqual({ totalCount: 0, byCause: [], details: [], recordCount: 0 });
  });
});
