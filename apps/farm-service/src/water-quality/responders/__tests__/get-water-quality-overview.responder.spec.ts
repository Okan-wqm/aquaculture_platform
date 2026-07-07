import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetWaterQualityOverviewResponder } from '../get-water-quality-overview.responder';

const TENANT = '33333333-3333-4333-8333-333333333333';

describe('GetWaterQualityOverviewResponder', () => {
  let responder: GetWaterQualityOverviewResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetWaterQualityOverviewResponder(mockDataSource);
  });

  it('returns empty for a missing/non-UUID tenant, without hitting the DB', async () => {
    expect(await responder.handleGetWaterQualityOverview({ tenantId: 'tenant_x' })).toEqual([]);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads recent measurements, maps params, and coalesces null/undefined', async () => {
    const measuredAt = new Date('2026-07-06T06:00:00.000Z');
    let findOptions: { order?: Record<string, string>; take?: number } | undefined;
    mockRunInTenantRead.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        const find = (_entity: unknown, opts: typeof findOptions): Promise<unknown[]> => {
          findOptions = opts;
          return Promise.resolve([
            {
              id: 'm1', tankId: 't1', pondId: null, measuredAt,
              temperature: 18.5, dissolvedOxygen: 7.2, pH: 7.8, ammonia: null, nitrite: undefined,
            },
          ]);
        };
        return fn({ manager: { find } });
      },
    );

    const result = await responder.handleGetWaterQualityOverview({ tenantId: TENANT });

    // newest-first + capped
    expect(findOptions?.order).toEqual({ measuredAt: 'DESC' });
    expect(findOptions?.take).toBe(25);

    expect(result).toEqual([
      {
        id: 'm1', tankId: 't1', pondId: null, measuredAt: '2026-07-06T06:00:00.000Z',
        temperature: 18.5, dissolvedOxygen: 7.2, pH: 7.8, ammonia: null, nitrite: null,
      },
    ]);
  });

  it('degrades to empty (never throws) if the read fails', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetWaterQualityOverview({ tenantId: TENANT })).toEqual([]);
  });
});
