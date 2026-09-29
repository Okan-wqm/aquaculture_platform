import { Injectable, Logger } from '@nestjs/common';
import type { TenantScope } from '@aquaculture/backend-common/database';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { CreateTaskInput } from '../dto/create-task.dto';
import { Task, TaskStatus } from '../entities/task.entity';
import { TaskService } from './task.service';
import { normaliseChecklistItems } from './task-checklist';

/**
 * The one task-create path: the task row plus its TaskCreated outbox event,
 * written on a write TenantScope (K10 layer 4, PR-T1).
 *
 * WHY a class of its own: the AI create_task tool reaches this through the
 * request.farm.createTask responder, and code on that path may write only
 * through the scope the responder skeleton opened — never through a
 * repository or DataSource of its own. TaskService.create (the GraphQL path)
 * opens a write scope and calls the same method, so both entry points share
 * one create-and-emit path, one entity shape and one event contract.
 *
 * INVARIANT: the row and its event commit in the scope's transaction, pinned
 * to `scope.tenantId`; if violated → a task (or its event) could land in
 * another tenant's schema.
 */
@Injectable()
export class TaskCreator {
  private readonly logger = new Logger(TaskCreator.name);

  constructor(private readonly outboxPublisher: OutboxPublisher) {}

  async create(scope: TenantScope, input: CreateTaskInput, createdBy: string): Promise<Task> {
    if (scope.access !== 'write') {
      throw new Error('TaskCreator.create needs a write scope');
    }
    const { manager, tenantId } = scope;
    const task = manager.create(Task, {
      tenantId,
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: TaskStatus.PENDING,
      assignedTo: input.assignedTo,
      assignedToName: input.assignedToName,
      createdBy,
      dueDate: new Date(input.dueDate),
      dueTime: input.dueTime,
      siteId: input.siteId,
      location: input.location,
      estimatedMinutes: input.estimatedMinutes,
      checklistItems: normaliseChecklistItems(input.checklistItems),
      notes: [],
      tags: input.tags,
      isRecurring: input.isRecurring || false,
      recurringTemplateId: input.recurringTemplateId,
    });

    const saved = await manager.save(task);

    await this.outboxPublisher.enqueue(
      {
        ...createBaseEvent('TaskCreated', tenantId, { userId: createdBy }),
        taskId: saved.id,
        title: saved.title,
        category: saved.category,
        priority: saved.priority,
        assignedTo: saved.assignedTo,
        assignedToName: saved.assignedToName,
        dueDate: input.dueDate,
        createdBy,
      },
      manager,
    );

    this.logger.log(`Task created: ${saved.id}`);
    return saved;
  }
}
