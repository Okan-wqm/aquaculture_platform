import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { collaborator } from '@platform/testing';
import type { TenantScope } from '@aquaculture/backend-common/database';

import {
  createFarmScopeHarness,
  type FarmScopeHarness,
} from '../../../__tests__/helpers/farm-tenant-scope.helper';
import { CreateTaskResponder, CreateTaskNatsRequest } from '../create-task.responder';
import type { CreateTaskInput } from '../../dto/create-task.dto';
import type { TaskCreator } from '../../services/task-creator';

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
  let harness: FarmScopeHarness;
  let create: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    harness = createFarmScopeHarness();
    create = jest.fn();
    responder = new CreateTaskResponder(
      harness.responder,
      collaborator<TaskCreator>({ create }, 'TaskCreator'),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects an unknown category (fail-closed) without writing a task', async () => {
    // SCENARIO: a category outside the domain enum.
    // EXPECTS: a domain rejection for the requesting tenant; no task is written.
    const res = await responder.handleCreateTask({ ...VALID, category: 'NONSENSE' });
    expect(res).toEqual({
      ok: true,
      tenantId: TENANT,
      data: { created: false, reason: expect.stringMatching(/category/i) },
    });
    expect(create).not.toHaveBeenCalled();
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
    expect(harness.conn.dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('creates the task through the one create path on a write scope pinned to the tenant', async () => {
    // SCENARIO: a valid request.
    // EXPECTS: TaskCreator runs on a genuine WRITE scope for the requesting tenant,
    //          the transaction commits, and the reply names the tenant read back.
    create.mockImplementation(async (scope: TenantScope, input: CreateTaskInput) => {
      expect(scope.tenantId).toBe(TENANT);
      expect(scope.access).toBe('write');
      return { id: 'task-9', title: input.title };
    });

    const res = await responder.handleCreateTask(VALID);

    expect(res).toEqual({
      ok: true,
      tenantId: TENANT,
      data: { created: true, taskId: 'task-9', title: 'Check pond 3' },
    });
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Check pond 3',
        category: 'WATER_QUALITY',
        priority: 'HIGH',
      }),
      'u-1',
    );
    expect(harness.conn.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('maps an unexpected create failure to INTERNAL_ERROR (no leak into the reply)', async () => {
    // SCENARIO: the DB write crashes with an internal message.
    // EXPECTS: INTERNAL_ERROR for the requesting tenant; the internal message stays in the server log.
    create.mockRejectedValue(new Error('deadlock detected on tasks'));
    const res = await responder.handleCreateTask(VALID);
    expect(res).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res)).not.toMatch(/deadlock/);
    expect(harness.conn.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});
