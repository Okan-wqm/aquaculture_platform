/**
 * Task checklist wire shape (FARM-HIGH-320).
 *
 * `checklistItems` used to be a `JSON` scalar that echoed whatever the JSONB
 * row held — including rows written by the retired `toggleChecklistItem` flip
 * (`completed` instead of `isCompleted`, no id) — so every client re-typed the
 * item and re-implemented the normaliser. The field is now served by a
 * @ResolveField that runs the SAME normaliser as the write path, on both Task
 * and RecurringTemplate.
 */
import { RecurringTemplate } from '../entities/recurring-template.entity';
import { Task } from '../entities/task.entity';
import { QueryBus } from '@platform/cqrs';
import { RecurringTemplateResolver } from '../resolvers/recurring-template.resolver';
import { TaskResolver } from '../resolvers/task.resolver';
import { RecurringTaskService } from '../services/recurring-task.service';
import { TaskService } from '../services/task.service';

// The field resolvers are pure over the parent row: no service or bus is
// touched, so the collaborators are empty by construction.
const taskService: Pick<TaskService, never> = {};
const recurringTaskService: Pick<RecurringTaskService, never> = {};
const queryBus: Pick<QueryBus, never> = {};

describe('checklistItems wire shape (FARM-HIGH-320)', () => {
  const taskResolver = new TaskResolver(taskService as TaskService, queryBus as QueryBus);
  const templateResolver = new RecurringTemplateResolver(
    recurringTaskService as RecurringTaskService,
    queryBus as QueryBus,
  );

  it('serves a legacy { text, completed } task row as the canonical item', () => {
    const task = Object.assign(new Task(), {
      checklistItems: [
        { text: 'Feed tank 3', completed: true },
        { id: 'item-2', text: 'Check O2', isCompleted: false, completedAt: null },
      ],
    });

    const wire = taskResolver.checklistItems(task);

    expect(wire).toHaveLength(2);
    expect(wire[0]).toMatchObject({ text: 'Feed tank 3', isCompleted: true });
    expect(typeof wire[0]?.id).toBe('string');
    expect(wire[0]).not.toHaveProperty('completed');
    expect(wire[1]).toEqual({
      id: 'item-2',
      text: 'Check O2',
      isCompleted: false,
      completedAt: null,
    });
  });

  it('serves an empty or missing checklist as an empty list, never null', () => {
    expect(taskResolver.checklistItems(Object.assign(new Task(), { checklistItems: [] }))).toEqual(
      [],
    );
    expect(taskResolver.checklistItems(new Task())).toEqual([]);
  });

  it('serves a recurring template checklist through the same normaliser', () => {
    const template = Object.assign(new RecurringTemplate(), {
      checklistItems: [{ text: 'Rinse filters' }],
    });

    const wire = templateResolver.checklistItems(template);

    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ text: 'Rinse filters', isCompleted: false });
    expect(typeof wire[0]?.id).toBe('string');
  });
});
