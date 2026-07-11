import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';
import { TaskService } from '../services/task.service';
import { TaskCategory, TaskPriority } from '../entities/task.entity';
import { CreateTaskInput } from '../dto/create-task.dto';

/**
 * Cross-service task creation over NATS request-reply. ai-service's
 * create_task tool (an actuation tool gated by the actuation policy) publishes
 * request.farm.createTask; this responder validates it and writes through the
 * SAME task-create SSoT the GraphQL resolver uses (TaskService.createWithManager),
 * inside a tenant-pinned transaction. There is no HTTP hop and no duplicated
 * task shape — the tool cannot bypass the outbox/event contract.
 */
export interface CreateTaskNatsRequest {
  tenantId: string;
  /** The user on whose behalf the AI is acting (creator + default assignee). */
  createdBy: string;
  assignedTo: string;
  assignedToName: string;
  title: string;
  description?: string;
  category: string;
  priority: string;
  /** ISO-8601 due date. */
  dueDate: string;
}

export interface CreateTaskNatsResponse {
  ok: boolean;
  taskId?: string;
  title?: string;
  /** User-facing reason on rejection (invalid enum, missing field, failure). */
  error?: string;
}

@Controller()
export class CreateTaskResponder {
  private readonly logger = new Logger(CreateTaskResponder.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly dataSource: DataSource,
  ) {}

  @MessagePattern('request.farm.createTask')
  async handleCreateTask(
    @Payload() payload: CreateTaskNatsRequest,
  ): Promise<CreateTaskNatsResponse> {
    // Fail-closed validation: an actuation crossing a service boundary must not
    // trust the caller's strings. Reject anything the domain would not accept
    // rather than coercing it.
    if (!payload?.tenantId || !payload.createdBy) {
      return { ok: false, error: 'tenantId and createdBy are required' };
    }
    const title = payload.title?.trim();
    if (!title) {
      return { ok: false, error: 'A task title is required' };
    }
    if (!Object.values(TaskCategory).includes(payload.category as TaskCategory)) {
      return { ok: false, error: `Unknown task category "${payload.category}"` };
    }
    if (!Object.values(TaskPriority).includes(payload.priority as TaskPriority)) {
      return { ok: false, error: `Unknown task priority "${payload.priority}"` };
    }
    const dueDate = new Date(payload.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return { ok: false, error: 'A valid ISO-8601 dueDate is required' };
    }

    const input: CreateTaskInput = {
      title,
      description: payload.description,
      category: payload.category as TaskCategory,
      priority: payload.priority as TaskPriority,
      assignedTo: payload.assignedTo || payload.createdBy,
      assignedToName: payload.assignedToName,
      dueDate: payload.dueDate,
    };

    try {
      const saved = await runInTenantTransaction(
        this.dataSource,
        'farm',
        payload.tenantId,
        (qr) =>
          this.taskService.createWithManager(
            qr.manager,
            payload.tenantId,
            input,
            payload.createdBy,
          ),
      );
      return { ok: true, taskId: saved.id, title: saved.title };
    } catch (err) {
      this.logger.error(
        `request.farm.createTask failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return { ok: false, error: 'Task could not be created' };
    }
  }
}
