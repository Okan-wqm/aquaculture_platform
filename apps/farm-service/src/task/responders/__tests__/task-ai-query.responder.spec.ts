import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { GetTaskStatsQuery } from '../../queries/get-task-stats.query';
import { ListTodaysTasksQuery } from '../../queries/list-todays-tasks.query';
import { TaskAiQueryResponder } from '../task-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('TaskAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: TaskAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new TaskAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it("today's tasks: checklist progress only, no assignee / notes", async () => {
    execute.mockResolvedValue([
      {
        id: ID,
        title: 'Check pond 3',
        category: 'GENERAL',
        priority: 'MEDIUM',
        status: 'PENDING',
        dueDate: new Date('2026-09-18T00:00:00Z'),
        dueTime: '08:30',
        siteId: undefined,
        location: 'Pond 3',
        estimatedMinutes: 20,
        isRecurring: false,
        assignedTo: 'user-5',
        assignedToName: 'Ali Veli',
        createdBy: 'user-1',
        checklistItems: [
          { id: 'a', isCompleted: true },
          { id: 'b', completed: false },
          { id: 'c' },
        ],
        notes: [{ text: 'private' }],
      },
    ]);

    const reply = await responder.listTodaysTasks({ tenantId: TENANT, limit: 10 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListTodaysTasksQuery));
    expect(reply).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: ID,
            title: 'Check pond 3',
            category: 'GENERAL',
            priority: 'MEDIUM',
            status: 'PENDING',
            dueDate: '2026-09-18T00:00:00.000Z',
            dueTime: '08:30',
            siteId: null,
            location: 'Pond 3',
            estimatedMinutes: 20,
            isRecurring: false,
            checklistTotal: 3,
            checklistDone: 1,
          },
        ],
        truncated: false,
      },
    });
    for (const secret of ['Ali Veli', 'user-5', 'user-1', 'private'])
      expect(JSON.stringify(reply)).not.toContain(secret);
  });

  it('task stats: projects the rate as pct', async () => {
    execute.mockResolvedValue({
      totalToday: 8,
      completedToday: 5,
      overdueCount: 2,
      upcomingCount: 11,
      completionRate: '62.5',
      avgCompletionMinutes: 34,
    });
    const reply = await responder.getStats({ tenantId: TENANT });
    expect(execute).toHaveBeenCalledWith(expect.any(GetTaskStatsQuery));
    expect(reply).toEqual({
      ok: true,
      data: {
        totalToday: 8,
        completedToday: 5,
        overdueCount: 2,
        upcomingCount: 11,
        completionRatePct: 62.5,
        avgCompletionMinutes: 34,
      },
    });
  });
});
