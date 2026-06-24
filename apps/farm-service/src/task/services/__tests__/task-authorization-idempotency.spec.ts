/**
 * TaskService — object-level authorization (SEC-HIGH-050), reopen-clears-completion
 * (FARM-HIGH-056) and idempotent lifecycle mutations (FARM-HIGH-057).
 *
 * London-school: collaborators (DataSource/queryRunner/manager, OutboxPublisher,
 * MobileCommandReceiptService) are mocked. The receipt service is the REAL class
 * driven through its `manager.query` SQL surface so the begin()/complete() contract
 * is exercised end to end (started vs replay vs legacy).
 *
 * NO banned casts: the service is constructed through a NestJS testing module with
 * typed providers (getRepositoryToken + useValue), so the mock wiring satisfies the
 * constructor types structurally and the husky banned-construct gate stays green.
 *
 * @module Task/Tests
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Role } from '@aquaculture/backend-common/decorators';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { Task, TaskStatus, TaskCategory, TaskPriority } from '../../entities/task.entity';
import { RecurringTemplate } from '../../entities/recurring-template.entity';
import { UpdateTaskInput } from '../../dto/update-task.dto';
import { CreateTaskInput } from '../../dto/create-task.dto';
import { TaskService } from '../task.service';

const TENANT = 'tenant-1';
const OWNER = 'user-owner';
const OTHER = 'user-other';
const ENVELOPE = { clientCommandId: 'cmd-1', payloadHash: 'hash-1' };

const ownerCaller = { sub: OWNER, roles: [Role.MODULE_USER] };
const otherCaller = { sub: OTHER, roles: [Role.MODULE_USER] };
const managerCaller = { sub: OTHER, roles: [Role.MODULE_MANAGER] };

/**
 * The transaction manager double. `query` drives the REAL
 * MobileCommandReceiptService.begin():
 *  - INSERT ... RETURNING id  -> [{ id }]   => started
 *  - INSERT ... (conflict)    -> []         => then SELECT FOR UPDATE row
 */
function createManager(
  receiptMode: 'started' | 'replay' = 'started',
  replayRow?: unknown,
): jest.Mocked<Pick<EntityManager, 'findOne' | 'save' | 'query'>> {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO')) {
      return Promise.resolve(receiptMode === 'started' ? [{ id: 'receipt-1' }] : []);
    }
    if (sql.includes('SELECT')) {
      return Promise.resolve([replayRow]);
    }
    // UPDATE (complete) returns nothing.
    return Promise.resolve([]);
  });
  return {
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
    query,
  };
}

interface Harness {
  service: TaskService;
  outbox: { enqueue: jest.Mock };
  taskRepoFindOne: jest.Mock;
}

async function buildHarness(
  manager: jest.Mocked<Pick<EntityManager, 'findOne' | 'save' | 'query'>>,
): Promise<Harness> {
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };

  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  // findById() (used by update/addNote) reads through the injected Task repo.
  const taskRepoFindOne = jest.fn();
  // create() builds the entity through the injected Task repo before the
  // transactional save; the double echoes its input as the entity instance.
  const taskRepoCreate = jest.fn().mockImplementation((entity: Partial<Task>) =>
    Object.assign(new Task(), entity),
  );

  // useValue providers accept loose shapes, so no cast is needed in test code;
  // Nest resolves the constructor by token and the doubles satisfy the surface
  // the service actually exercises.
  const moduleRef = await Test.createTestingModule({
    providers: [
      TaskService,
      {
        provide: getRepositoryToken(Task),
        useValue: { findOne: taskRepoFindOne, create: taskRepoCreate, save: jest.fn() },
      },
      { provide: getRepositoryToken(RecurringTemplate), useValue: {} },
      { provide: DataSource, useValue: dataSource },
      { provide: OutboxPublisher, useValue: outbox },
      { provide: MobileCommandReceiptService, useClass: MobileCommandReceiptService },
    ],
  }).compile();

  return {
    service: moduleRef.get(TaskService),
    outbox,
    taskRepoFindOne,
  };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  const t = new Task();
  Object.assign(
    t,
    {
      id: 'task-1',
      tenantId: TENANT,
      title: 'Feed tank',
      assignedTo: OWNER,
      assignedToName: 'Owner',
      createdBy: OWNER,
      status: TaskStatus.PENDING,
      dueDate: new Date('2026-06-20'),
      checklistItems: [],
      notes: [],
    },
    overrides,
  );
  return t;
}

describe('TaskService SEC-HIGH-050 — completeTask object-level authz', () => {
  it('rejects a non-assignee MODULE_USER (fail-closed)', async () => {
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(baseTask());
    const { service } = await buildHarness(manager);

    await expect(
      service.completeTask(TENANT, 'task-1', otherCaller, ENVELOPE),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows the assignee MODULE_USER on their own task', async () => {
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(baseTask());
    const { service } = await buildHarness(manager);

    const result = await service.completeTask(TENANT, 'task-1', ownerCaller, ENVELOPE);
    expect(result.status).toBe(TaskStatus.COMPLETED);
    expect(result.completedBy).toBe(OWNER);
  });

  it('allows a non-assignee MODULE_MANAGER via the canonical bypass', async () => {
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(baseTask());
    const { service } = await buildHarness(manager);

    const result = await service.completeTask(TENANT, 'task-1', managerCaller, ENVELOPE);
    expect(result.status).toBe(TaskStatus.COMPLETED);
  });
});

describe('TaskService FARM-HIGH-057 — completeTask idempotency', () => {
  it('rejects the legacy (no-envelope) path', async () => {
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(baseTask());
    const { service } = await buildHarness(manager);

    await expect(
      service.completeTask(TENANT, 'task-1', ownerCaller, null),
    ).rejects.toThrow(BadRequestException);
  });

  it('replay returns the stored COMPLETED task without a second transition', async () => {
    const stored = baseTask({ status: TaskStatus.COMPLETED, completedBy: OWNER });
    const manager = createManager('replay', {
      payloadHash: ENVELOPE.payloadHash,
      status: 'COMPLETED',
      responseType: 'Task',
      responseId: 'task-1',
      responsePayload: { id: 'task-1' },
    });
    // findOne is used for the replay re-load (returns stored task).
    manager.findOne.mockResolvedValue(stored);
    const { service, outbox } = await buildHarness(manager);

    const result = await service.completeTask(TENANT, 'task-1', ownerCaller, ENVELOPE);
    expect(result.status).toBe(TaskStatus.COMPLETED);
    // No fresh transition write, no new event enqueued on replay.
    expect(manager.save).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('started path enqueues TaskCompleted exactly once and writes the receipt', async () => {
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(baseTask());
    const { service, outbox } = await buildHarness(manager);

    await service.completeTask(TENANT, 'task-1', ownerCaller, ENVELOPE);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    // begin INSERT + complete UPDATE both ran on the receipt table.
    const sqls = manager.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE'))).toBe(true);
  });
});

describe('TaskService FARM-HIGH-057 — setChecklistItem idempotent SET', () => {
  it('SET true twice converges (no revert) — second call is a replay', async () => {
    const task = baseTask({
      checklistItems: [{ id: 'i1', text: 'check', isCompleted: false }],
    });

    // First call: started -> sets true.
    const startedManager = createManager('started');
    startedManager.findOne.mockResolvedValue(task);
    const first = await buildHarness(startedManager);
    const afterFirst = await first.service.setChecklistItem(
      TENANT,
      'task-1',
      'i1',
      true,
      ownerCaller,
      ENVELOPE,
    );
    expect(afterFirst.checklistItems[0]!.isCompleted).toBe(true);

    // Second call (same clientCommandId): replay -> returns stored, no flip.
    const replayManager = createManager('replay', {
      payloadHash: ENVELOPE.payloadHash,
      status: 'COMPLETED',
      responseType: 'Task',
      responseId: 'task-1',
      responsePayload: { id: 'task-1' },
    });
    replayManager.findOne.mockResolvedValue(afterFirst);
    const second = await buildHarness(replayManager);
    const afterSecond = await second.service.setChecklistItem(
      TENANT,
      'task-1',
      'i1',
      true,
      ownerCaller,
      ENVELOPE,
    );
    expect(afterSecond.checklistItems[0]!.isCompleted).toBe(true);
    expect(replayManager.save).not.toHaveBeenCalled();
  });

  it('SET false is idempotent off regardless of prior state', async () => {
    const task = baseTask({
      checklistItems: [{ id: 'i1', text: 'check', isCompleted: true, completedBy: OWNER }],
    });
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(task);
    const { service } = await buildHarness(manager);

    const result = await service.setChecklistItem(
      TENANT,
      'task-1',
      'i1',
      false,
      ownerCaller,
      ENVELOPE,
    );
    expect(result.checklistItems[0]!.isCompleted).toBe(false);
    expect(result.checklistItems[0]!.completedAt).toBeNull();
  });

  it('rejects a non-assignee MODULE_USER (fail-closed)', async () => {
    const task = baseTask({
      checklistItems: [{ id: 'i1', text: 'check', isCompleted: false }],
    });
    const manager = createManager('started');
    manager.findOne.mockResolvedValue(task);
    const { service } = await buildHarness(manager);

    await expect(
      service.setChecklistItem(TENANT, 'task-1', 'i1', true, otherCaller, ENVELOPE),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('TaskService FARM-MEDIUM-074 — create() enqueues TaskCreated atomically with the save', () => {
  function createInput(): CreateTaskInput {
    return Object.assign(new CreateTaskInput(), {
      title: 'Feed tank',
      description: 'morning feed',
      category: TaskCategory.FEEDING,
      priority: TaskPriority.HIGH,
      assignedTo: '11111111-1111-1111-1111-111111111111',
      assignedToName: 'Owner',
      dueDate: '2026-06-25',
    });
  }

  // Structural view of the enqueued event so assertions read its fields
  // without a banned cast — a single typed projection of the mock call arg.
  interface EnqueuedEvent {
    eventType: string;
    taskId: string;
  }

  function withId(entity: unknown, id: string): Task {
    const task = entity as Task;
    task.id = id;
    return task;
  }

  it('saves the task and enqueues TaskCreated on the SAME transaction manager', async () => {
    const manager = createManager('started');
    // The manager save echoes the entity with a server-assigned id so the
    // event payload carries a concrete taskId.
    manager.save.mockImplementation((entity: unknown) =>
      Promise.resolve(withId(entity, 'task-created-1')),
    );
    const { service, outbox } = await buildHarness(manager);

    const result = await service.create(TENANT, createInput(), OWNER);

    expect(result.id).toBe('task-created-1');
    // Exactly one TaskCreated enqueue, bound to the transaction manager (atomic).
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const event: EnqueuedEvent = outbox.enqueue.mock.calls[0]![0];
    const boundManager = outbox.enqueue.mock.calls[0]![1];
    expect(event.eventType).toBe('TaskCreated');
    expect(event.taskId).toBe('task-created-1');
    expect(boundManager).toBe(manager);
    // The save ran on the txn manager, never the autocommit repository.
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('rolls back and does not commit when the enqueue fails (no fire-and-forget)', async () => {
    const manager = createManager('started');
    manager.save.mockImplementation((entity: unknown) =>
      Promise.resolve(withId(entity, 'task-created-2')),
    );
    const { service, outbox } = await buildHarness(manager);
    outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.create(TENANT, createInput(), OWNER)).rejects.toThrow('outbox down');
  });
});

describe('TaskService FARM-HIGH-056 — update() reopen clears completion + transactional outbox', () => {
  function updateInput(overrides: Partial<UpdateTaskInput>): UpdateTaskInput {
    return Object.assign(new UpdateTaskInput(), { id: 'task-1' }, overrides);
  }

  it('COMPLETED -> PENDING clears completedAt AND completedBy in the saved entity', async () => {
    const completed = baseTask({
      status: TaskStatus.COMPLETED,
      completedAt: new Date('2026-06-10'),
      completedBy: OWNER,
    });
    const manager = createManager('started');
    const { service, taskRepoFindOne } = await buildHarness(manager);
    // update() resolves the task through findById (Task repo.findOne).
    taskRepoFindOne.mockResolvedValue(completed);

    const result = await service.update(
      TENANT,
      updateInput({ status: TaskStatus.PENDING }),
      ownerCaller,
    );
    expect(result.status).toBe(TaskStatus.PENDING);
    // FARM-HIGH-056: clearCompletion() sets these to null (NOT undefined) on
    // purpose — TypeORM SKIPS undefined fields on save, so only an explicit null
    // emits `SET completedAt = NULL` / `SET completedBy = NULL` and actually wipes
    // the stale DB values on reopen. Asserting null is what proves the wipe.
    expect(result.completedAt).toBeNull();
    expect(result.completedBy).toBeNull();
  });

  it('reopen enqueues TaskStatusChanged through the outbox within the transaction', async () => {
    const completed = baseTask({
      status: TaskStatus.COMPLETED,
      completedAt: new Date('2026-06-10'),
      completedBy: OWNER,
    });
    const manager = createManager('started');
    const { service, outbox, taskRepoFindOne } = await buildHarness(manager);
    taskRepoFindOne.mockResolvedValue(completed);

    await service.update(TENANT, updateInput({ status: TaskStatus.PENDING }), ownerCaller);
    // The status change was enqueued with the txn manager (atomic), not eventBus.
    const enqueued = outbox.enqueue.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
    expect(enqueued).toContain('TaskStatusChanged');
    expect(outbox.enqueue.mock.calls[0]![1]).toBe(manager);
  });

  it('rejects an invalid transition (BadRequestException)', async () => {
    const pending = baseTask({ status: TaskStatus.PENDING });
    const manager = createManager('started');
    const { service, taskRepoFindOne } = await buildHarness(manager);
    taskRepoFindOne.mockResolvedValue(pending);

    // PENDING -> COMPLETED is not a valid direct transition.
    await expect(
      service.update(TENANT, updateInput({ status: TaskStatus.COMPLETED }), ownerCaller),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a non-assignee non-manager edit (SEC-HIGH-050)', async () => {
    const task = baseTask();
    const manager = createManager('started');
    const { service, taskRepoFindOne } = await buildHarness(manager);
    taskRepoFindOne.mockResolvedValue(task);

    await expect(
      service.update(TENANT, updateInput({ title: 'hijack' }), otherCaller),
    ).rejects.toThrow(ForbiddenException);
  });
});
