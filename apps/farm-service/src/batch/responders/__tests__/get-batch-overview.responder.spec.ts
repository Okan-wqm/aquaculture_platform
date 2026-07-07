import 'reflect-metadata';

// Override only runInTenantRead while keeping the rest of the barrel real
// (isValidUUID exercises the genuine fail-safe; the entity's barrel deps stay).
const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetBatchOverviewResponder } from '../get-batch-overview.responder';

const TENANT = '22222222-2222-4222-8222-222222222222';

describe('GetBatchOverviewResponder', () => {
  let responder: GetBatchOverviewResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetBatchOverviewResponder(mockDataSource);
  });

  it('returns an empty overview for a missing/non-UUID tenant, without hitting the DB', async () => {
    expect(await responder.handleGetBatchOverview({ tenantId: 'tenant_abc123' })).toEqual([]);
    expect(await responder.handleGetBatchOverview({ tenantId: '' })).toEqual([]);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads batches through the tenant-context SSoT and maps identity + status', async () => {
    const changedAt = new Date('2026-07-01T08:00:00.000Z');
    mockRunInTenantRead.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        const qr = {
          manager: {
            find: jest.fn().mockResolvedValue([
              { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: changedAt },
              { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
            ]),
          },
        };
        return fn(qr);
      },
    );

    const result = await responder.handleGetBatchOverview({ tenantId: TENANT });

    expect(result).toEqual([
      { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: '2026-07-01T08:00:00.000Z' },
      { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
    ]);
  });

  it('degrades to an empty overview (never throws) if the read fails', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetBatchOverview({ tenantId: TENANT })).toEqual([]);
  });
});
