import 'reflect-metadata';

import { createFarmScopeHarness, type FarmScopeHarness } from '../../../__tests__/helpers/farm-tenant-scope.helper';
import { GetBatchOverviewResponder } from '../get-batch-overview.responder';

const TENANT = '22222222-2222-4222-8222-222222222222';
/** K10 (MT-HIGH-062): a payload without a valid tenant names no tenant in its reply. */
const INVALID = { ok: false, tenantId: null, error: 'INVALID_REQUEST' };

describe('GetBatchOverviewResponder', () => {
  let responder: GetBatchOverviewResponder;
  let harness: FarmScopeHarness;

  beforeEach(() => {
    harness = createFarmScopeHarness();
    responder = new GetBatchOverviewResponder(harness.responder);
  });

  it('rejects a missing/non-UUID tenant as INVALID_REQUEST naming no tenant, without hitting the DB', async () => {
    expect(await responder.handleGetBatchOverview({ tenantId: 'tenant_abc123' })).toEqual(INVALID);
    expect(await responder.handleGetBatchOverview({ tenantId: '' })).toEqual(INVALID);
    expect(harness.conn.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('reads batches on the skeleton tenant scope and maps identity + status', async () => {
    const changedAt = new Date('2026-07-01T08:00:00.000Z');
    harness.conn.manager.find.mockResolvedValue([
      { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: changedAt },
      { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
    ]);

    const result = await responder.handleGetBatchOverview({ tenantId: TENANT });

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT,
      data: [
        { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: '2026-07-01T08:00:00.000Z' },
        { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
      ],
    });
  });

  it('turns a read failure into INTERNAL_ERROR for the requesting tenant — never an empty list, never a throw', async () => {
    harness.conn.manager.find.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetBatchOverview({ tenantId: TENANT })).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
  });
});
