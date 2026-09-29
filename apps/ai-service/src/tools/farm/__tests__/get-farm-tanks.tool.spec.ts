import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmTanksTool } from '../get-farm-tanks.tool';
import {
  boundReply,
  humanToolContext,
  tenantBoundClient,
} from '../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';

const CTX = humanToolContext({
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  personaTier: 'operator',
  offeredToolNames: [],
  actuationPolicy: 'allowed',
});

describe('GetFarmTanksTool', () => {
  let send: jest.Mock;
  let tool: GetFarmTanksTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmTanksTool(tenantBoundClient({ send }));
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_tanks');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests the registry for the context tenant and returns the tank list + count', async () => {
    send.mockReturnValue(
      of(
        boundReply(
          [
            { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
            { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'ACTIVE' },
          ],
          CTX.tenant.tenantId,
        ),
      ),
    );

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      tanks: [
        { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
        { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'ACTIVE' },
      ],
      count: 2,
    });
    expect(send).toHaveBeenCalledWith('request.farm.getTankRegistry', {
      tenantId: CTX.tenant.tenantId,
    });
  });

  it('coalesces an empty/absent registry to a zero-count result', async () => {
    send.mockReturnValue(of(boundReply([], CTX.tenant.tenantId)));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tanks: [], count: 0 });
  });

  it('refuses a pre-K10 bare-array reply instead of handing it to the model', async () => {
    // SCENARIO: a farm-service that predates the tenant-bound envelope answers with a bare list.
    // EXPECTS: a tool error — the rows carry no proof of which tenant they belong to.
    send.mockReturnValue(of([{ id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' }]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unrecognised reply/);
  });
});
