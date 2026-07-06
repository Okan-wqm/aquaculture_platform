import 'reflect-metadata';
import { of, throwError } from 'rxjs';
import { CreateTaskTool } from '../create-task.tool';
import type { ToolExecutionContext } from '../../core/tool.interface';

const CTX: ToolExecutionContext = {
  tenantId: 't-1',
  schemaName: 'tenant_t1',
  userId: 'u-42',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

const INPUT = {
  title: 'Check pond 3',
  description: 'cloudy',
  category: 'WATER_QUALITY',
  priority: 'HIGH',
  dueDate: '2026-07-10T09:00:00Z',
};

describe('CreateTaskTool', () => {
  let send: jest.Mock;
  let tool: CreateTaskTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new CreateTaskTool({ send });
  });

  it('advertises itself as an actuation tool that requires confirmation', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(true);
    expect(tool.getMetadata().name).toBe('create_task');
  });

  it('self-assigns to the requesting user and returns the created task id', async () => {
    send.mockReturnValue(of({ ok: true, taskId: 'task-7', title: 'Check pond 3' }));

    const result = await tool.execute(INPUT, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ taskId: 'task-7', title: 'Check pond 3', assignedToSelf: true });

    // The request self-assigns (assignedTo = caller) and carries the tenant + creator.
    expect(send).toHaveBeenCalledWith(
      'request.farm.createTask',
      expect.objectContaining({
        tenantId: 't-1',
        createdBy: 'u-42',
        assignedTo: 'u-42',
        title: 'Check pond 3',
        category: 'WATER_QUALITY',
        priority: 'HIGH',
      }),
    );
  });

  it('surfaces a farm-side rejection as a tool error', async () => {
    send.mockReturnValue(of({ ok: false, error: 'Unknown task category "X"' }));
    const result = await tool.execute(INPUT, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/category/i);
  });

  it('fails cleanly when the responder is unreachable', async () => {
    send.mockReturnValue(throwError(() => new Error('no responders')));
    const result = await tool.execute(INPUT, CTX);
    expect(result.success).toBe(false);
  });
});
