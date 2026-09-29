import 'reflect-metadata';

import { createFarmScopeHarness, type FarmScopeHarness } from '../../../__tests__/helpers/farm-tenant-scope.helper';
import { GetFeedingOverviewResponder } from '../get-feeding-overview.responder';

const TENANT = '55555555-5555-4555-8555-555555555555';
/** K10 (MT-HIGH-062): a payload without a valid tenant names no tenant in its reply. */
const INVALID = { ok: false, tenantId: null, error: 'INVALID_REQUEST' };

describe('GetFeedingOverviewResponder', () => {
  let responder: GetFeedingOverviewResponder;
  let harness: FarmScopeHarness;

  beforeEach(() => {
    harness = createFarmScopeHarness();
    responder = new GetFeedingOverviewResponder(harness.responder);
  });

  it('rejects a missing/non-UUID tenant as INVALID_REQUEST naming no tenant, without hitting the DB', async () => {
    expect(await responder.handleGetFeedingOverview({ tenantId: 'tenant_x' })).toEqual(INVALID);
    expect(harness.conn.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('reads recent feedings, normalises the DATE column, and maps planned/actual kg', async () => {
    const find = jest.fn().mockResolvedValue([
      { id: 'f1', batchId: 'b1', tankId: 't1', feedingDate: new Date('2026-07-06T00:00:00.000Z'), feedingTime: '08:00', plannedAmount: 12.5, actualAmount: 12.0 },
      { id: 'f2', batchId: 'b1', tankId: null, feedingDate: '2026-07-05', feedingTime: '16:00', plannedAmount: 10, actualAmount: 10 },
    ]);
    harness.conn.manager.find.mockImplementation(find);

    const result = await responder.handleGetFeedingOverview({ tenantId: TENANT });

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT,
      data: [
        { id: 'f1', batchId: 'b1', tankId: 't1', feedingDate: '2026-07-06', feedingTime: '08:00', plannedAmountKg: 12.5, actualAmountKg: 12.0 },
        { id: 'f2', batchId: 'b1', tankId: null, feedingDate: '2026-07-05', feedingTime: '16:00', plannedAmountKg: 10, actualAmountKg: 10 },
      ],
    });
  });

  it('turns a read failure into INTERNAL_ERROR for the requesting tenant — never an empty list, never a throw', async () => {
    harness.conn.manager.find.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetFeedingOverview({ tenantId: TENANT })).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
  });
});
