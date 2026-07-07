/**
 * GetTransfersSummaryHandler — cross-site transfer roll-up. Same-site moves
 * are excluded in SQL; the spec locks the parameterisation and row mapping.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetTransfersSummaryHandler } from '../../query-handlers/get-transfers-summary.handler';
import { GetTransfersSummaryQuery } from '../../queries/get-transfers-summary.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

describe('GetTransfersSummaryHandler', () => {
  it('maps grouped transfer rows with direction, species and counterparty', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ recordCount: '3' }]);
      }
      if (sql.includes('FROM tank_operations')) {
        return Promise.resolve([
          {
            date: '2026-06-05',
            direction: 'OUT',
            speciesCode: 'SEABASS',
            fishCount: '5000',
            biomassKg: '1250.5',
            counterparty: 'North Site',
          },
          {
            date: '2026-06-20',
            direction: 'IN',
            speciesCode: 'SEABREAM',
            fishCount: '2000',
            biomassKg: null,
            counterparty: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await new GetTransfersSummaryHandler(mockDataSource).execute(
      new GetTransfersSummaryQuery(tenantId, siteId, '2026-06-01', '2026-06-30'),
    );

    expect(result.records).toEqual([
      {
        date: '2026-06-05',
        direction: 'OUT',
        speciesCode: 'SEABASS',
        fishCount: 5000,
        biomassKg: 1250.5,
        counterparty: 'North Site',
      },
      {
        date: '2026-06-20',
        direction: 'IN',
        speciesCode: 'SEABREAM',
        fishCount: 2000,
        biomassKg: 0,
        counterparty: undefined,
      },
    ]);
    expect(result.recordCount).toBe(3);
  });

  it('excludes same-site moves in SQL and parameterises the boundary check', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();

    await new GetTransfersSummaryHandler(mockDataSource).execute(
      new GetTransfersSummaryQuery(tenantId, siteId, '2026-06-01', '2026-06-30'),
    );

    const call = (mockQueryRunner.query as jest.Mock).mock.calls.find(
      ([sql]) => String(sql).includes('FROM tank_operations') && !String(sql).includes('COUNT(*)'),
    );
    expect(call).toBeDefined();
    const sql = String(call?.[0]);
    expect(sql).toContain(`other_side.site_id IS NULL OR other_side.site_id <> $2`);
    expect(call?.[1]).toEqual([tenantId, siteId, '2026-06-01', '2026-06-30']);
  });
});
