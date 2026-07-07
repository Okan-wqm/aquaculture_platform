import 'reflect-metadata';

// Override only runInTenantRead (the DB path) while keeping the rest of the
// barrel real — isValidUUID exercises the genuine fail-safe guard, and the
// entity's own barrel dependencies stay intact.
const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetTankRegistryResponder } from '../get-tank-registry.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('GetTankRegistryResponder', () => {
  let responder: GetTankRegistryResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetTankRegistryResponder(mockDataSource);
  });

  it('returns an empty registry for a missing/non-UUID tenant, without hitting the DB', async () => {
    expect(await responder.handleGetTankRegistry({ tenantId: 'tenant_abc123' })).toEqual([]);
    expect(await responder.handleGetTankRegistry({ tenantId: '' })).toEqual([]);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads tanks through the tenant-context SSoT and maps them to the registry shape', async () => {
    mockRunInTenantRead.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        const qr = {
          manager: {
            find: jest.fn().mockResolvedValue([
              { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
              { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'MAINTENANCE' },
            ]),
          },
        };
        return fn(qr);
      },
    );

    const result = await responder.handleGetTankRegistry({ tenantId: TENANT });

    expect(result).toEqual([
      { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
      { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'MAINTENANCE' },
    ]);
  });

  it('degrades to an empty registry (never throws) if the read fails', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetTankRegistry({ tenantId: TENANT })).toEqual([]);
  });
});
