import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetHarvestOverviewResponder } from '../get-harvest-overview.responder';

const TENANT = '44444444-4444-4444-8444-444444444444';
/** K10 (MT-HIGH-062): a payload without a valid tenant names no tenant in its reply. */
const INVALID = { ok: false, tenantId: null, error: 'INVALID_REQUEST' };

describe('GetHarvestOverviewResponder', () => {
  let responder: GetHarvestOverviewResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetHarvestOverviewResponder(mockDataSource);
  });

  it('rejects a missing/non-UUID tenant as INVALID_REQUEST naming no tenant, without hitting the DB', async () => {
    expect(await responder.handleGetHarvestOverview({ tenantId: 'tenant_x' })).toEqual(INVALID);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads plans and normalises the DATE column to YYYY-MM-DD (Date or string)', async () => {
    mockRunInTenantRead.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        const find = jest.fn().mockResolvedValue([
          { id: 'h1', planCode: 'HP-2024-001', name: 'Levrek hasat', batchId: 'b1', status: 'scheduled', plannedDate: new Date('2026-07-15T00:00:00.000Z') },
          { id: 'h2', planCode: 'HP-2024-002', name: 'Çipura hasat', batchId: 'b2', status: 'planned', plannedDate: '2026-08-01' },
        ]);
        return fn({ manager: { find } });
      },
    );

    const result = await responder.handleGetHarvestOverview({ tenantId: TENANT });

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT,
      data: [
        { id: 'h1', planCode: 'HP-2024-001', name: 'Levrek hasat', batchId: 'b1', status: 'scheduled', plannedDate: '2026-07-15' },
        { id: 'h2', planCode: 'HP-2024-002', name: 'Çipura hasat', batchId: 'b2', status: 'planned', plannedDate: '2026-08-01' },
      ],
    });
  });

  it('turns a read failure into INTERNAL_ERROR for the requesting tenant — never an empty list, never a throw', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetHarvestOverview({ tenantId: TENANT })).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
  });
});
