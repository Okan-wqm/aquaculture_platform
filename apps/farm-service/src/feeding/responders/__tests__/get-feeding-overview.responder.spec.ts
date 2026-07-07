import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetFeedingOverviewResponder } from '../get-feeding-overview.responder';

const TENANT = '55555555-5555-4555-8555-555555555555';

describe('GetFeedingOverviewResponder', () => {
  let responder: GetFeedingOverviewResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetFeedingOverviewResponder(mockDataSource);
  });

  it('returns empty for a missing/non-UUID tenant, without hitting the DB', async () => {
    expect(await responder.handleGetFeedingOverview({ tenantId: 'tenant_x' })).toEqual([]);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads recent feedings, normalises the DATE column, and maps planned/actual kg', async () => {
    mockRunInTenantRead.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        const find = jest.fn().mockResolvedValue([
          { id: 'f1', batchId: 'b1', tankId: 't1', feedingDate: new Date('2026-07-06T00:00:00.000Z'), feedingTime: '08:00', plannedAmount: 12.5, actualAmount: 12.0 },
          { id: 'f2', batchId: 'b1', tankId: null, feedingDate: '2026-07-05', feedingTime: '16:00', plannedAmount: 10, actualAmount: 10 },
        ]);
        return fn({ manager: { find } });
      },
    );

    const result = await responder.handleGetFeedingOverview({ tenantId: TENANT });

    expect(result).toEqual([
      { id: 'f1', batchId: 'b1', tankId: 't1', feedingDate: '2026-07-06', feedingTime: '08:00', plannedAmountKg: 12.5, actualAmountKg: 12.0 },
      { id: 'f2', batchId: 'b1', tankId: null, feedingDate: '2026-07-05', feedingTime: '16:00', plannedAmountKg: 10, actualAmountKg: 10 },
    ]);
  });

  it('degrades to empty (never throws) if the read fails', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetFeedingOverview({ tenantId: TENANT })).toEqual([]);
  });
});
