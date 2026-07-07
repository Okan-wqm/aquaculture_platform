import 'reflect-metadata';
import { of } from 'rxjs';
import { GetFarmBatchesTool } from '../get-farm-batches.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  schemaName: 'tenant_2222222222222222',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

describe('GetFarmBatchesTool', () => {
  let send: jest.Mock;
  let tool: GetFarmBatchesTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetFarmBatchesTool({ send });
  });

  it('is a plain read tool (no confirmation)', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(false);
    expect(tool.getMetadata().name).toBe('get_farm_batches');
    expect(tool.getMetadata().category).toBe('farm_query');
  });

  it('requests the overview for the context tenant and returns the batch list + count', async () => {
    send.mockReturnValue(
      of([
        { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: null },
        { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
      ]),
    );

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      batches: [
        { id: 'b1', batchNumber: 'B-2024-001', name: 'Levrek A', status: 'ACTIVE', statusChangedAt: null },
        { id: 'b2', batchNumber: 'B-2024-002', name: null, status: 'GROWING', statusChangedAt: null },
      ],
      count: 2,
    });
    expect(send).toHaveBeenCalledWith('request.farm.getBatchOverview', {
      tenantId: CTX.tenantId,
    });
  });

  it('coalesces an empty/absent overview to a zero-count result', async () => {
    send.mockReturnValue(of([]));
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ batches: [], count: 0 });
  });
});
