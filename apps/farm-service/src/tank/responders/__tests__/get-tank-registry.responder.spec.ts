import 'reflect-metadata';

import { createFarmScopeHarness, type FarmScopeHarness } from '../../../__tests__/helpers/farm-tenant-scope.helper';
import { GetTankRegistryResponder } from '../get-tank-registry.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
/** K10 (MT-HIGH-062): a payload without a valid tenant names no tenant in its reply. */
const INVALID = { ok: false, tenantId: null, error: 'INVALID_REQUEST' };

describe('GetTankRegistryResponder', () => {
  let responder: GetTankRegistryResponder;
  let harness: FarmScopeHarness;

  beforeEach(() => {
    harness = createFarmScopeHarness();
    responder = new GetTankRegistryResponder(harness.responder);
  });

  it('rejects a missing/non-UUID tenant as INVALID_REQUEST naming no tenant, without hitting the DB', async () => {
    expect(await responder.handleGetTankRegistry({ tenantId: 'tenant_abc123' })).toEqual(INVALID);
    expect(await responder.handleGetTankRegistry({ tenantId: '' })).toEqual(INVALID);
    expect(harness.conn.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('reads tanks on the skeleton tenant scope and maps them to the registry shape', async () => {
    harness.conn.manager.find.mockResolvedValue([
      { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
      { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'MAINTENANCE' },
    ]);

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
    harness.conn.manager.find.mockRejectedValue(new Error('connection reset'));
    expect(await responder.handleGetTankRegistry({ tenantId: TENANT })).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
  });
});
