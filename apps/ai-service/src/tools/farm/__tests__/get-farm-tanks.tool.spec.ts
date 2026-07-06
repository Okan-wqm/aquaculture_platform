import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmTanksTool } from '../get-farm-tanks.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

describe('GetFarmTanksTool', () => {
  let send: jest.Mock;
  let tool: GetFarmTanksTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmTanksTool({ send });
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_tanks');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests the registry for the context tenant and returns the tank list + count', async () => {
    send.mockReturnValue(
      of([
        { id: 't1', code: 'TNK-001', name: 'Havuz 1', status: 'ACTIVE' },
        { id: 't2', code: 'TNK-002', name: 'Havuz 2', status: 'ACTIVE' },
      ]),
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
      tenantId: CTX.tenantId,
    });
  });

  it('coalesces an empty/absent registry to a zero-count result', async () => {
    send.mockReturnValue(of([]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tanks: [], count: 0 });
  });
});
