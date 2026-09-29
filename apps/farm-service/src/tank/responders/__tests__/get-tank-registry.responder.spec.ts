import 'reflect-metadata';

// Override only runInTenantRead (the DB path) while keeping the rest of the
// barrel real — the tenant-bound skeleton's UUID guard runs for real, and the
// entity's own barrel dependencies stay intact.
const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { GetTankRegistryResponder } from '../get-tank-registry.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
/** K10 (MT-HIGH-062): a payload without a valid tenant names no tenant in its reply. */
const INVALID = { ok: false, tenantId: null, error: 'INVALID_REQUEST' };

describe('GetTankRegistryResponder', () => {
  let responder: GetTankRegistryResponder;

  beforeEach(() => {
    mockRunInTenantRead.mockReset();
    const { mockDataSource } = createMockDataSource();
    responder = new GetTankRegistryResponder(mockDataSource);
  });

  it('rejects a missing/non-UUID tenant as INVALID_REQUEST naming no tenant, without hitting the DB', async () => {
    expect(await responder.handleGetTankRegistry({ tenantId: 'tenant_abc123' })).toEqual(INVALID);
    expect(await responder.handleGetTankRegistry({ tenantId: '' })).toEqual(INVALID);
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

    expect(result).toEqual({
      ok: true,
      tenantId: TENANT,
      data: [
        { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
        { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'MAINTENANCE' },
      ],
    });
  });

  it('turns a read failure into INTERNAL_ERROR for the requesting tenant — never an empty list, never a throw', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetTankRegistry({ tenantId: TENANT })).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
  });
});
