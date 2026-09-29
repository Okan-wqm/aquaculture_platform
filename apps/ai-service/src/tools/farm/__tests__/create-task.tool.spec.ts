import 'reflect-metadata';
import { of, throwError } from 'rxjs';
import { CreateTaskTool } from '../create-task.tool';
import {
  TENANT_A,
  TENANT_B,
  boundFailure,
  boundReply,
  humanToolContext,
  tenantBoundClient,
} from '../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { TenantBoundaryViolation } from '../../../tenant-boundary/tenant-boundary-violation';

const CTX = humanToolContext({
  userId: 'u-42',
  userRoles: ['operator'],
  persona: 'operator',
  personaTier: 'operator',
  actuationPolicy: 'allowed',
});

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
    tool = new CreateTaskTool(tenantBoundClient({ send }));
  });

  it('advertises itself as an actuation tool that requires confirmation', () => {
    expect(tool.getMetadata().requiresConfirmation).toBe(true);
    expect(tool.getMetadata().name).toBe('create_task');
  });

  it('self-assigns to the requesting user and returns the created task id', async () => {
    send.mockReturnValue(
      of(boundReply({ created: true, taskId: 'task-7', title: 'Check pond 3' })),
    );

    const result = await tool.execute(INPUT, CTX);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ taskId: 'task-7', title: 'Check pond 3', assignedToSelf: true });

    // The request self-assigns (assignedTo = caller) and carries the bound tenant + creator.
    expect(send).toHaveBeenCalledWith(
      'request.farm.createTask',
      expect.objectContaining({
        tenantId: TENANT_A,
        createdBy: 'u-42',
        assignedTo: 'u-42',
        title: 'Check pond 3',
        category: 'WATER_QUALITY',
        priority: 'HIGH',
      }),
    );
  });

  it('surfaces a farm-side rejection as a tool error', async () => {
    send.mockReturnValue(of(boundReply({ created: false, reason: 'Unknown task category "X"' })));
    const result = await tool.execute(INPUT, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/category/i);
  });

  it('fails cleanly when the responder is unreachable', async () => {
    send.mockReturnValue(throwError(() => new Error('no responders')));
    const result = await tool.execute(INPUT, CTX);
    expect(result.success).toBe(false);
  });

  it('surfaces a same-tenant transport failure as a tool error', async () => {
    // SCENARIO: farm-service could not write the task (INTERNAL_ERROR for this tenant).
    // EXPECTS: a tool error the model can relay; nothing thrown past the tool.
    send.mockReturnValue(of(boundFailure('INTERNAL_ERROR')));
    const result = await tool.execute(INPUT, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/);
  });

  it('stops the run when the confirmation reply names another tenant', async () => {
    // SCENARIO: the createTask reply claims to have written the task in tenant B.
    // EXPECTS: TenantBoundaryViolation escapes the tool — no "task created" reaches the model.
    send.mockReturnValue(
      of(boundReply({ created: true, taskId: 'task-b', title: 'Check pond 3' }, TENANT_B)),
    );
    await expect(tool.execute(INPUT, CTX)).rejects.toBeInstanceOf(TenantBoundaryViolation);
  });
});
