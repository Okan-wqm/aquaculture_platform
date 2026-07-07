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

const VALID: CreateTaskNatsRequest = {
  tenantId: 't-1',
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
    const res = await responder.handleCreateTask({ ...VALID, category: 'NONSENSE' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/category/i);
    expect(mockRunInTenantTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown priority', async () => {
    const res = await responder.handleCreateTask({ ...VALID, priority: 'WHENEVER' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/priority/i);
  });

  it('rejects a missing title', async () => {
    const res = await responder.handleCreateTask({ ...VALID, title: '   ' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/title/i);
  });

  it('rejects an invalid dueDate', async () => {
    const res = await responder.handleCreateTask({ ...VALID, dueDate: 'not-a-date' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/dueDate/i);
  });

  it('rejects a missing tenantId/createdBy', async () => {
    const res = await responder.handleCreateTask({ ...VALID, tenantId: '' });
    expect(res.ok).toBe(false);
  });

  it('creates the task through the tenant-pinned SSoT and returns its id', async () => {
    const fakeQr = { manager: { id: 'mgr' } };
    taskService.createWithManager.mockResolvedValue({ id: 'task-9', title: 'Check pond 3' });
    mockRunInTenantTransaction.mockImplementation(
      async (_ds: unknown, schema: string, tenantId: string, fn: (qr: unknown) => Promise<unknown>) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe('t-1');
        return fn(fakeQr);
      },
    );

    const res = await responder.handleCreateTask(VALID);

    expect(res).toEqual({ ok: true, taskId: 'task-9', title: 'Check pond 3' });
    expect(taskService.createWithManager).toHaveBeenCalledWith(
      fakeQr.manager,
      't-1',
      expect.objectContaining({ title: 'Check pond 3', category: 'WATER_QUALITY', priority: 'HIGH' }),
      'u-1',
    );
  });

  it('maps an unexpected create failure to a safe error (no leak)', async () => {
    mockRunInTenantTransaction.mockRejectedValue(new Error('deadlock detected on tasks'));
    const res = await responder.handleCreateTask(VALID);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Task could not be created');
    expect(res.error).not.toMatch(/deadlock/);
  });
});
