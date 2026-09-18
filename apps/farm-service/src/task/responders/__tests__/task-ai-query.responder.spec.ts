import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { TaskAiQueryResponder } from '../task-ai-query.responder';
import { ListTodaysTasksQuery } from '../../queries/list-todays-tasks.query';
import { GetTaskStatsQuery } from '../../queries/get-task-stats.query';
import { Task } from '../../entities/task.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';

function task(id: string): Task {
  return {
    id,
    tenantId: TENANT,
    title: 'Check DO sensor',
    description: 'desc',
    category: 'WATER_QUALITY' as Task['category'],
    priority: 'HIGH' as Task['priority'],
    status: 'PENDING' as Task['status'],
    assignedTo: 'assignee-user-id', // PII — must never cross the wire
    assignedToName: 'Ayse Yilmaz', // PII — must never cross the wire
    createdBy: 'creator-user-id', // PII — must never cross the wire
    dueDate: new Date('2026-09-18T00:00:00.000Z'),
    dueTime: '08:30:00',
    siteId: SITE,
    location: 'Cage row 2',
    estimatedMinutes: 30,
    checklistItems: [{ label: 'calibrate' }], // must never cross the wire
    notes: [{ body: 'operator note' }], // must never cross the wire
    tags: ['sensor'],
    isRecurring: true,
  } as unknown as Task;
}

const STATS = {
  totalToday: 12,
  completedToday: 5,
  overdueCount: 3,
  upcomingCount: 20,
  completionRate: 72,
  avgCompletionMinutes: 41,
};

describe('TaskAiQueryResponder (PR-5 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: TaskAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new TaskAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ------------------------------------------------------------------ TASKS_TODAY
  it('TASKS_TODAY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [null, { tenantId: 'bad' }, { tenantId: TENANT, limit: 51 }]) {
      expect(await responder.today(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('TASKS_TODAY: happy path bounds the list and strips crew PII', async () => {
    execute.mockResolvedValue(Array.from({ length: 60 }, (_, i) => task(`task${i}`)));

    const reply = await responder.today({ tenantId: TENANT, limit: 50 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListTodaysTasksQuery));
    expect((execute.mock.calls[0][0] as ListTodaysTasksQuery).tenantId).toBe(TENANT);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.items[0]?.dueDate).toBe('2026-09-18T00:00:00.000Z');
      expect(reply.data.items[0]?.dueTime).toBe('08:30:00');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('assignedTo');
      expect(serialized).not.toContain('assignedToName');
      expect(serialized).not.toContain('createdBy');
      expect(serialized).not.toContain('checklistItems');
      expect(serialized).not.toContain('operator note');
    }
  });

  it('TASKS_TODAY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.today({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // -------------------------------------------------------------------- TASK_STATS
  it('TASK_STATS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.stats({})).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('TASK_STATS: happy path passes the counters through', async () => {
    execute.mockResolvedValue(STATS);

    const reply = await responder.stats({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(GetTaskStatsQuery));
    expect(reply).toMatchObject({
      ok: true,
      data: { totalToday: 12, overdueCount: 3, completionRate: 72 },
    });
  });

  it('TASK_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.stats({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
