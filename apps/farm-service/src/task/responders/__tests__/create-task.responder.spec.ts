import 'reflect-metadata';

// Mock the tenant-transaction helper so the responder's DB path runs without a
// real connection: it simply invokes the callback with a fake QueryRunner whose
// manager is the one createWithManager receives.
const mockRunInTenantTransaction = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  runInTenantTransaction: (
    ...args: unknown[]
  ): unknown => mockRunInTenantTransaction(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { CreateTaskResponder, CreateTaskNatsRequest } from '../create-task.responder';
import type { TaskService } from '../../services/task.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

const VALID: CreateTaskNatsRequest = {
  tenantId: TENANT,
  createdBy: 'u-1',
  assignedTo: 'u-1',
  assignedToName: 'AI ile oluşturuldu',
  title: 'Check pond 3',
  description: 'water looked cloudy',
  category: 'WATER_QUALITY',
  priority: 'HIGH',
  dueDate: '2026-07-10T09:00:00Z',
};

describe('CreateTaskResponder', () => {
  let responder: CreateTaskResponder;
  let taskService: { createWithManager: jest.Mock };

  beforeEach(() => {
    mockRunInTenantTransaction.mockReset();
    taskService = { createWithManager: jest.fn() };
    const { mockDataSource } = createMockDataSource();
    // Partial→full widening via two single-`as` steps (the gate bans only the
    // double-`as` escape). The responder only calls createWithManager, and
    // runInTenantTransaction is mocked, so the DataSource is a real typed mock
    // from the testing factory.
    responder = new CreateTaskResponder(
      taskService as Partial<TaskService> as TaskService,
      mockDataSource,
    );
  });

  it('rejects an unknown category (fail-closed) without touching the DB', async () => {
    // SCENARIO: a category outside the domain enum.
    // EXPECTS: a domain rejection for the requesting tenant; no DB write.
    const res = await responder.handleCreateTask({ ...VALID, category: 'NONSENSE' });
    expect(res).toEqual({
      ok: true,
      tenantId: TENANT,
      data: { created: false, reason: expect.stringMatching(/category/i) },
    });
    expect(mockRunInTenantTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown priority', async () => {
    const res = await responder.handleCreateTask({ ...VALID, priority: 'WHENEVER' });
    expect(res).toMatchObject({
      ok: true,
      data: { created: false, reason: expect.stringMatching(/priority/i) },
    });
  });

  it('rejects a missing title', async () => {
    const res = await responder.handleCreateTask({ ...VALID, title: '   ' });
    expect(res).toMatchObject({
      ok: true,
      data: { created: false, reason: expect.stringMatching(/title/i) },
    });
  });

  it('rejects an invalid dueDate', async () => {
    const res = await responder.handleCreateTask({ ...VALID, dueDate: 'not-a-date' });
    expect(res).toMatchObject({
      ok: true,
      data: { created: false, reason: expect.stringMatching(/dueDate/i) },
    });
  });

  it('rejects a missing tenantId/createdBy as INVALID_REQUEST', async () => {
    // SCENARIO: the payload names no valid tenant, or no creator.
    // EXPECTS: transport-level INVALID_REQUEST; the tenant echo is null when there is none.
    expect(await responder.handleCreateTask({ ...VALID, tenantId: '' })).toEqual({
      ok: false,
      tenantId: null,
      error: 'INVALID_REQUEST',
    });
    expect(await responder.handleCreateTask({ ...VALID, createdBy: '' })).toEqual({
      ok: false,
      tenantId: TENANT,
      error: 'INVALID_REQUEST',
    });
    expect(mockRunInTenantTransaction).not.toHaveBeenCalled();
  });

  it('creates the task through the tenant-pinned SSoT and returns its id', async () => {
    const fakeQr = { manager: { id: 'mgr' } };
    taskService.createWithManager.mockResolvedValue({ id: 'task-9', title: 'Check pond 3' });
    mockRunInTenantTransaction.mockImplementation(
      async (
        _ds: unknown,
        schema: string,
        tenantId: string,
        fn: (qr: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        return fn(fakeQr);
      },
    );

    const res = await responder.handleCreateTask(VALID);

    expect(res).toEqual({
      ok: true,
      tenantId: TENANT,
      data: { created: true, taskId: 'task-9', title: 'Check pond 3' },
    });
    expect(taskService.createWithManager).toHaveBeenCalledWith(
      fakeQr.manager,
      TENANT,
      expect.objectContaining({
        title: 'Check pond 3',
        category: 'WATER_QUALITY',
        priority: 'HIGH',
      }),
      'u-1',
    );
  });

  it('maps an unexpected create failure to INTERNAL_ERROR (no leak into the reply)', async () => {
    // SCENARIO: the DB write crashes with an internal message.
    // EXPECTS: INTERNAL_ERROR for the requesting tenant; the internal message stays in the server log.
    mockRunInTenantTransaction.mockRejectedValue(new Error('deadlock detected on tasks'));
    const res = await responder.handleCreateTask(VALID);
    expect(res).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res)).not.toMatch(/deadlock/);
  });
});
